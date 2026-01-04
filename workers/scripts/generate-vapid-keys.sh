#!/bin/bash
# Generate VAPID keys for Web Push notifications

set -e

TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

# Generate EC private key
openssl ecparam -genkey -name prime256v1 -noout -out "$TEMP_DIR/private.pem" 2>/dev/null

# Export private key in PKCS8 DER format, then base64url encode
PRIVATE_KEY=$(openssl pkcs8 -topk8 -nocrypt -in "$TEMP_DIR/private.pem" -outform DER 2>/dev/null | base64 | tr '+/' '-_' | tr -d '=\n')

# Export public key in raw format (uncompressed point), then base64url encode
# For P-256, the uncompressed public key is 65 bytes (0x04 || 32-byte X || 32-byte Y)
PUBLIC_KEY=$(openssl ec -in "$TEMP_DIR/private.pem" -pubout -outform DER 2>/dev/null | tail -c 65 | base64 | tr '+/' '-_' | tr -d '=\n')

echo ""
echo "=== VAPID Keys Generated ==="
echo ""
echo "Run these commands to set the secrets:"
echo ""
echo "  wrangler secret put VAPID_PRIVATE_KEY"
echo "  # Paste: $PRIVATE_KEY"
echo ""
echo "  wrangler secret put VAPID_PUBLIC_KEY"
echo "  # Paste: $PUBLIC_KEY"
echo ""
echo "Add to wrangler.toml [vars]:"
echo ""
echo "  VAPID_SUBJECT = \"mailto:admin@yourdomain.com\""
echo ""
