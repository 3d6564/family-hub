import crypto from 'node:crypto';
import { operationsType, userDataType } from './anylist-protocol.js';

const origin = 'https://www.anylist.com';
const maxBytes = 8 * 1024 * 1024;
const safeString = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;

/** Encode protobuf operations as a binary multipart field without a file name. */
function operationsForm(bytes) {
  const boundary = `----familyHub${crypto.randomUUID().replaceAll('-', '')}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="operations"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    Buffer.from(bytes),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

/** A provider failure whose message is safe for users and never includes provider output. */
export class AnyListError extends Error {
  constructor(message = 'AnyList could not update. Check the connection and try again.', status = 502) {
    super(message);
    this.status = status;
  }
}

/** Validate the small token record retained by Family Hub, without retaining a password. */
export function validAnyListSession(session) {
  return session && ['clientId', 'accessToken', 'refreshToken'].every(key => safeString(session[key], 16384));
}

/** Minimal HTTPS client for the unofficial AnyList list protocol. */
export function createAnyListClient({ session, fetchImpl = fetch, saveSession = () => {} } = {}) {
  session = session ? { ...session } : { clientId: crypto.randomUUID().replaceAll('-', '').toUpperCase() };

  async function request(endpoint, form, authenticated = true) {
    let response;
    try {
      const headers = { 'X-AnyLeaf-API-Version': '3', ...(authenticated ? {
        'X-AnyLeaf-Client-Identifier': session.clientId, authorization: `Bearer ${session.accessToken}`,
      } : {}), ...(form?.contentType ? { 'content-type': form.contentType } : {}) };
      response = await fetchImpl(`${origin}${endpoint}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers, body: form?.body ?? form,
      });
      if (!response.ok) {
        await response.body?.cancel();
        return { status: response.status };
      }
      const chunks = []; let size = 0;
      if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw new AnyListError(); }
      if (response.body) for await (const chunk of response.body) {
        size += chunk.length;
        if (size > maxBytes) { await response.body.cancel().catch(() => {}); throw new AnyListError(); }
        chunks.push(Buffer.from(chunk));
      }
      return { status: response.status, bytes: Buffer.concat(chunks) };
    } catch { throw new AnyListError(); }
  }

  async function tokens(endpoint, fields) {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    const result = await request(endpoint, form, false);
    if ([401, 403].includes(result.status)) throw new AnyListError('AnyList sign-in expired or was rejected. Ask an adult to reconnect.', 409);
    if (!result.bytes) throw new AnyListError();
    let data;
    try { data = JSON.parse(result.bytes.toString('utf8')); } catch { throw new AnyListError(); }
    const next = { clientId: session.clientId, accessToken: data.access_token, refreshToken: data.refresh_token };
    if (!validAnyListSession(next)) throw new AnyListError();
    session = next;
    await saveSession({ ...session });
    return { ...session };
  }

  async function authorized(endpoint, form) {
    let result = await request(endpoint, form);
    // A rejected authentication has not applied the operation. Other failures are never retried.
    if (result.status === 401) {
      await tokens('/auth/token/refresh', { refresh_token: session.refreshToken });
      result = await request(endpoint, form);
    }
    if ([401, 403].includes(result.status)) throw new AnyListError('AnyList sign-in expired or was rejected. Ask an adult to reconnect.', 409);
    if (!result.bytes) throw new AnyListError();
    return result.bytes;
  }

  return {
    async login(email, password) { return tokens('/auth/token', { email, password }); },
    async lists() {
      const bytes = await authorized('/data/user-data/get');
      try {
        const decoded = userDataType.decode(bytes), data = decoded.shoppingListsResponse;
        if (!data || data.modifiedLists?.length) throw new Error('Not a full list response');
        const lists = data.newLists || [];
        if (lists.length > 200) throw new Error('Too many lists');
        const ids = new Set();
        return lists.map(list => {
          if (!safeString(list.identifier, 160) || !safeString(list.name, 200) || ids.has(list.identifier) || list.items.length > 10000) throw new Error('Invalid list');
          ids.add(list.identifier);
          const itemIds = new Set();
          return { id: list.identifier, name: list.name, items: list.items.map(item => {
            if (!safeString(item.identifier, 160) || !safeString(item.name, 500) || itemIds.has(item.identifier) || (item.listId && item.listId !== list.identifier) || item.details.length > 10000) throw new Error('Invalid item');
            itemIds.add(item.identifier);
            const quantity = item.quantityPb?.amount || item.deprecatedQuantity || '';
            const quantityUnit = item.quantityPb?.unit || '';
            if (quantity.length > 200 || quantityUnit.length > 200) throw new Error('Invalid quantity');
            return { id: item.identifier, name: item.name, notes: item.details || '', checked: !!item.checked, quantity, quantityUnit };
          }) };
        });
      } catch { throw new AnyListError('AnyList returned an unsupported list response. Ask an adult to check the connection.'); }
    },
    async change(listId, action, item) {
      const handlers = { add: 'add-shopping-list-item', check: 'set-list-item-checked', delete: 'remove-shopping-list-item' };
      if (!handlers[action]) throw new AnyListError('This AnyList action is not supported.', 400);
      const operation = { metadata: { operationId: crypto.randomUUID().replaceAll('-', '').toUpperCase(), handlerId: handlers[action] }, listId, listItemId: item.id };
      if (action === 'check') operation.updatedValue = item.checked ? 'y' : 'n';
      if (action === 'add' || action === 'delete') operation.listItem = { identifier: item.id, listId, name: item.name, checked: !!item.checked, details: item.notes || '', ...(item.quantity || item.quantityUnit ? { quantityPb: { amount: item.quantity || '', unit: item.quantityUnit || '' } } : {}) };
      const form = operationsForm(operationsType.encode({ operations: [operation] }).finish());
      await authorized('/data/shopping-lists/update', form);
    },
  };
}
