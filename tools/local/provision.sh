#!/usr/bin/env bash
# ACBP-P0-021 local-dev database provisioning. Runs inside the dedicated WSL distro as root.
# No secret in this file: the dev password is read from $ACBP_PW (passed via WSLENV), never
# hard-coded or printed. Creates a long-lived dev database + a disposable test database.
set -e
if ! command -v pg_ctlcluster >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq postgresql-16 postgresql-client-16 >/dev/null 2>&1
fi
pg_ctlcluster 16 main start 2>/dev/null || service postgresql start 2>/dev/null || true
for i in $(seq 1 30); do
  pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1 && break
  sleep 1
done
pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1 || { echo PG_NOT_READY; exit 1; }
# Idempotent: create the dev role if absent and (re)set its password; create the long-lived dev DB
# if absent; always (re)create the disposable test DB.
sudo -u postgres psql -v ON_ERROR_STOP=1 -q <<SQL
SELECT 'CREATE ROLE acbp_dev LOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname='acbp_dev')\gexec
ALTER ROLE acbp_dev WITH LOGIN PASSWORD '${ACBP_PW}';
SELECT 'CREATE DATABASE acbp_dev OWNER acbp_dev' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='acbp_dev')\gexec
SQL
sudo -u postgres psql -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS acbp_test;" -c "CREATE DATABASE acbp_test OWNER acbp_dev;"
echo SETUP_OK
