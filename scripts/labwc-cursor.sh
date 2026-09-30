#!/bin/sh
# Start Labwc without the Pi's forced plane mode so the pointer can update on its own.
. /usr/bin/setup_env
unset WLR_DRM_FORCE_LIBLIFTOFF
exec /usr/bin/labwc -m "$@"
