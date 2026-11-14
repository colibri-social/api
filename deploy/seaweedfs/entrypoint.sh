#!/bin/sh
set -eu

if [ -z "${S3_ACCESS_KEY:-}" ] || [ -z "${S3_SECRET_KEY:-}" ]; then
	echo "seaweedfs: set POLYFILL_S3_ACCESS_KEY_ID and POLYFILL_S3_SECRET_ACCESS_KEY" >&2
	exit 1
fi

mkdir -p /etc/seaweedfs
cat > /etc/seaweedfs/s3.json <<EOF
{
  "identities": [
    {
      "name": "colibri",
      "credentials": [{ "accessKey": "${S3_ACCESS_KEY}", "secretKey": "${S3_SECRET_KEY}" }],
      "actions": ["Admin", "Read", "Write", "List", "Tagging"]
    }
  ]
}
EOF

exec weed server \
	-dir=/data \
	-ip.bind=0.0.0.0 \
	-master.volumeSizeLimitMB=1024 \
	-volume.max=0 \
	-s3 \
	-s3.port=8333 \
	-s3.config=/etc/seaweedfs/s3.json
