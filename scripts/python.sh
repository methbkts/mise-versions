#!/usr/bin/env bash
# shellcheck disable=SC1091
set -euxo pipefail

if [ "${DRY_RUN:-}" == 0 ]; then
	git config --local user.email "189793748+mise-en-versions@users.noreply.github.com"
	git config --local user.name "mise-en-versions"
fi

cp docs/python-precompiled python-precompiled
rm -rf docs
mkdir -p docs
mv python-precompiled docs/python-precompiled
./scripts/python-precompiled.sh 1

if [ "${DRY_RUN:-}" == 0 ] && ! git diff-index --cached --quiet HEAD; then
	git diff --compact-summary --cached
	git commit -m "python-precompiled"
	git pull --autostash --rebase origin main
	git push
fi 
