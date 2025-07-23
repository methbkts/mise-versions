#!/usr/bin/env bash
# shellcheck disable=SC1091
source env_parallel.bash
set -euo pipefail

export MISE_NODE_MIRROR_URL="https://nodejs.org/dist/"
export MISE_USE_VERSIONS_HOST=0
export MISE_LIST_ALL_VERSIONS=1
export MISE_LOG_HTTP=1

# GitHub Token Manager configuration
export TOKEN_MANAGER_URL="${TOKEN_MANAGER_URL:-}"
export TOKEN_MANAGER_SECRET="${TOKEN_MANAGER_SECRET:-}"

if [ "${DRY_RUN:-}" == 0 ]; then
	git config --local user.email "189793748+mise-en-versions@users.noreply.github.com"
	git config --local user.name "mise-en-versions"
fi

fetch() {
	# Function to record token usage for monitoring
	record_token_usage() {
		local plugin_name="$1"
		local token_id="$2"
		local remaining="${3:-}"
		local reset_time="${4:-}"
		
		if [ -z "$TOKEN_MANAGER_URL" ] || [ -z "$TOKEN_MANAGER_SECRET" ]; then
			return
		fi
		
		# Record usage asynchronously to not slow down the main process
		{
			if [ -n "$remaining" ] && [ -n "$reset_time" ]; then
				node scripts/github-token.js record-usage \
					"$token_id" \
					"/repos/*/$plugin_name" \
					"$remaining" \
					"$reset_time" \
					|| true
			else
				node scripts/github-token.js record-usage \
					"$token_id" \
					"/repos/*/$plugin_name" \
					|| true
			fi
		} &
	}

	# Function to mark a token as rate-limited
	mark_token_rate_limited() {
		local token_id="$1"
		local reset_time="${2:-}"
		
		if [ -z "$TOKEN_MANAGER_URL" ] || [ -z "$TOKEN_MANAGER_SECRET" ]; then
			return
		fi
		
		echo "🚫 Marking token $token_id as rate-limited" >&2
		
		# Mark token as rate-limited asynchronously
		{
			if [ -n "$reset_time" ]; then
				node scripts/github-token.js mark-rate-limited "$token_id" "$reset_time" || true
			else
				node scripts/github-token.js mark-rate-limited "$token_id" || true
			fi
		} &
	}

	# Function to get a fresh GitHub token from the token manager
	get_github_token() {
		if [ -z "$TOKEN_MANAGER_URL" ] || [ -z "$TOKEN_MANAGER_SECRET" ]; then
			echo "❌ TOKEN_MANAGER_URL and TOKEN_MANAGER_SECRET not set, stopping processing" >&2
			exit 1
		fi

		echo "🔄 Getting fresh GitHub token from token manager..." >&2
		
		# Use the github-token.js script to get a token
		# Capture both stdout (token) and stderr (includes token_id)
		local token_output
		if ! token_output=$(node scripts/github-token.js get-token 2>&1); then
			echo "❌ Failed to get token from token manager, stopping processing" >&2
			exit 1
		fi
		
		# Extract token (last line of output) and token_id (from stderr)
		local token
		local token_id
		
		token=$(echo "$token_output" | tail -1)
		token_id=$(echo "$token_output" | grep "TOKEN_ID:" | cut -d: -f2 || echo "unknown")
		
		if [ -n "$GITHUB_ACTIONS" ]; then
			# In GitHub Actions, just return the token response
			echo "✅ Token obtained from token manager (ID: $token_id)" >&2
			echo "$token $token_id"
		else
			# For local runs, return token and token_id
			echo "$token $token_id"
		fi
	}

	case "$1" in
	awscli-local) # TODO: remove this when it is working
		echo "Skipping $1"
		return
		;;
	jfrog-cli | minio | tiny | teleport-ent | flyctl | flyway | vim | awscli | aws | aws-cli | checkov | snyk | chromedriver | sui | rebar)
		echo "Skipping $1"
		return
		;;
	esac
	
	# Get a fresh token for this fetch operation
	local token_info
	token_info=$(get_github_token)
	local token
	local token_id
	
	# Parse token and token_id from the response
	if [[ "$token_info" == *" "* ]]; then
		token=$(echo "$token_info" | cut -d' ' -f1)
		token_id=$(echo "$token_info" | cut -d' ' -f2)
	else
		# No valid token received, stop processing
		echo "❌ No valid token received, stopping processing"
		exit 1
	fi
	
	GITHUB_TOKEN="$token" mise x -- wait-for-gh-rate-limit || true
	echo "Fetching $1 (using token ID: $token_id)"
	
	# Create a temporary file to capture stderr and check for rate limiting
	local stderr_file
	stderr_file=$(mktemp)
	
	if ! docker run -e GITHUB_TOKEN="$token" -e MISE_USE_VERSIONS_HOST -e MISE_LIST_ALL_VERSIONS -e MISE_LOG_HTTP -e MISE_EXPERIMENTAL -e MISE_TRUSTED_CONFIG_PATHS=/ \
		jdxcode/mise -y ls-remote "$1" >"docs/$1" 2>"$stderr_file"; then
		echo "Failed to fetch versions for $1"
		
		# Check if this was a rate limit issue (403 Forbidden)
		if grep -q "403 Forbidden" "$stderr_file"; then
			echo "⚠️  Rate limit hit for token $token_id on $1, marking token as rate-limited" >&2
			
			# Extract rate limit reset time from response headers if available
			local reset_time
			reset_time=$(grep -i "x-ratelimit-reset" "$stderr_file" | cut -d: -f2 | tr -d ' ' || echo "")
			
			# Mark this specific token as rate-limited
			mark_token_rate_limited "$token_id" "$reset_time"
			
			echo "🔄 Will try with a different token next time" >&2
		else
			# Show the actual error for non-rate-limit failures
			cat "$stderr_file" >&2
		fi
		
		rm -f "$stderr_file" "docs/$1"
		return
	fi
	
	# Clean up stderr file
	rm -f "$stderr_file"

	# Record successful token usage
	record_token_usage "$1" "$token_id"

	new_lines=$(wc -l <"docs/$1")
	if [ ! "$new_lines" -gt 1 ]; then
		echo "No versions for $1" >/dev/null
		rm -f "docs/$1"
	else
		case "$1" in
		cargo-binstall)
			mv docs/cargo-binstall{,.tmp}
			grep -E '^[0-9]' docs/cargo-binstall.tmp >docs/cargo-binstall
			rm docs/cargo-binstall.tmp
			git add "docs/$1"
			;;
		rust)
			if [ "$new_lines" -gt 10 ]; then
				git add "docs/$1"
			fi
			;;
		java)
			sort -V "docs/$1" -o "docs/$1"
			git add "docs/$1"
			;;
		vault | consul | nomad | terraform | packer | vagrant | boundary | protobuf)
			mv "docs/$1"{,.tmp}
			grep -E '^[0-9]' "docs/$1.tmp" >"docs/$1"
			rm "docs/$1.tmp"
			sort -V "docs/$1" -o "docs/$1"
			git add "docs/$1"
			;;
		*)
			git add "docs/$1"
			;;
		esac
	fi
}

# Enhanced token management setup
setup_token_management() {
	echo "🔧 Setting up token management..." >&2
	
	if [ -n "$TOKEN_MANAGER_URL" ] && [ -n "$TOKEN_MANAGER_SECRET" ]; then
		echo "✅ Using GitHub Token Manager at $TOKEN_MANAGER_URL" >&2
		
		# Check token manager health
		if curl -f -s "$TOKEN_MANAGER_URL/health" >/dev/null 2>&1; then
			echo "✅ Token manager is healthy" >&2
			
			# Get token statistics
			if STATS=$(curl -s -H "Authorization: Bearer $TOKEN_MANAGER_SECRET" "$TOKEN_MANAGER_URL/api/stats" 2>/dev/null); then
				ACTIVE_TOKENS=$(echo "$STATS" | jq -r '.active // 0' 2>/dev/null || echo "0")
				echo "📊 Available tokens: $ACTIVE_TOKENS" >&2
				
				if [ "$ACTIVE_TOKENS" -eq 0 ]; then
					echo "❌ No active tokens available, stopping processing" >&2
					exit 1
				fi
			fi
		else
			echo "❌ Token manager health check failed, stopping processing" >&2
			exit 1
		fi
	else
		echo "❌ Token manager not configured, stopping processing" >&2
		exit 1
	fi
}

# Setup token management before starting
setup_token_management

docker run jdxcode/mise -v
tools="$(docker run -e MISE_EXPERIMENTAL=1 jdxcode/mise registry | awk '{print $1}')"

# Enhanced parallel processing with better token distribution
echo "🚀 Starting parallel fetch operations..."
# Prevent broken pipe error by collecting tools first
tools_limited=$(echo "$tools" | shuf -n 100)
echo "$tools_limited" | env_parallel -j4 fetch {} || true

# Clean up any background processes
wait

if [ "${DRY_RUN:-}" == 0 ] && ! git diff-index --cached --quiet HEAD; then
	git diff --compact-summary --cached
	git commit -m "versions"
	git pull --autostash --rebase origin main
	git push
fi

echo "✅ Update complete!"
