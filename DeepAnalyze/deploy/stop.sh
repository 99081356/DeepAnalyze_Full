#!/bin/bash
# Stop script (convenience wrapper for deploy.sh stop)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$SCRIPT_DIR/deploy.sh" stop
