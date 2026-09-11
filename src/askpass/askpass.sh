#!/bin/sh
VSCODE_GIT_GRAPH_ASKPASS_PIPE=`mktemp`
# Git hands the whole prompt over as a single argument ("Password for 'https://host': ").
# Split it into the request phrase and the quoted host, so they reach askpassMain as
# exactly two arguments with spaces intact — the upstream script relied on an unquoted
# "$*", whose word splitting also reduced the request to its first word.
request="${1%% \'*}"
host="${1#"$request" }"
VSCODE_GIT_GRAPH_ASKPASS_PIPE="$VSCODE_GIT_GRAPH_ASKPASS_PIPE" "$VSCODE_GIT_GRAPH_ASKPASS_NODE" "$VSCODE_GIT_GRAPH_ASKPASS_MAIN" "$request" "${host% }"
cat "$VSCODE_GIT_GRAPH_ASKPASS_PIPE"
rm "$VSCODE_GIT_GRAPH_ASKPASS_PIPE"
