#!/usr/bin/env bash
set -euo pipefail

if [[ -f ".env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source ".env"
  set +a
fi

: "${PORT:?PORT nao definido no ambiente}"
BASE_URL="${BASE_URL:-http://localhost:${PORT}}"
QUERY="${1:-dipirona}"
UNIDADE_NEGOCIO_ID="${UNIDADE_NEGOCIO_ID:-70826}"

curl --silent --show-error --location \
  --request POST "${BASE_URL}/api/buscar-medicamentos" \
  --header 'Content-Type: application/json' \
  --data "{\"query\":\"${QUERY}\",\"unidade_negocio_id\":${UNIDADE_NEGOCIO_ID}}"

echo
