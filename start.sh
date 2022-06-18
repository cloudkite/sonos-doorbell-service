#! /bin/bash
set -e
cd $(dirname "${BASH_SOURCE[0]}")
export PORT=5050
npm start
