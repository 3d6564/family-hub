import protobuf from 'protobufjs/light.js';

// Fixed subset of the observed AnyList wire format. Unknown account fields are skipped.
// Reference: kevdliu/anylist, d69278a6a7ec04750dadfdf9c6f8b1b157b3a7e8.
const field = (type, id, rule) => ({ type, id, ...(rule ? { rule } : {}) });
const root = protobuf.Root.fromJSON({ nested: {
  Quantity: { fields: { amount: field('string', 1), unit: field('string', 2) } },
  Item: { fields: {
    identifier: field('string', 1, 'required'), listId: field('string', 3),
    name: field('string', 4), details: field('string', 5), checked: field('bool', 6),
    userId: field('string', 12), categoryMatchId: field('string', 13),
    manualSortIndex: field('int32', 17), deprecatedQuantity: field('string', 18), quantityPb: field('Quantity', 21),
  } },
  List: { fields: {
    identifier: field('string', 1, 'required'), name: field('string', 3), items: field('Item', 4, 'repeated'),
  } },
  Lists: { fields: { newLists: field('List', 1, 'repeated'), modifiedLists: field('List', 2, 'repeated') } },
  UserData: { fields: { shoppingListsResponse: field('Lists', 1) } },
  Metadata: { fields: { operationId: field('string', 1), handlerId: field('string', 2) } },
  Operation: { fields: {
    metadata: field('Metadata', 1), listId: field('string', 2), listItemId: field('string', 3),
    updatedValue: field('string', 4), listItem: field('Item', 6),
  } },
  Operations: { fields: { operations: field('Operation', 1, 'repeated') } },
} });

export const userDataType = root.lookupType('UserData');
export const operationsType = root.lookupType('Operations');
