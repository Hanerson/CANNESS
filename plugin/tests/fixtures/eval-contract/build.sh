#!/usr/bin/env bash
# Contract v1 fixture: the last stdout line is the executable path.
set -euo pipefail
cat > demo <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x demo
echo "build ok"
echo "$PWD/demo"
