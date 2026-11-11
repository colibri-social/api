---
"@colibri-social/appview": patch
---

Use mediasoup's kernel6 prebuilt worker in the image. On build hosts with a 7.x kernel, mediasoup picked the kernel7 worker, which needs a newer glibc than the image has, and compiled the worker from source on every uncached build. The Dockerfile now downloads the worker for `MEDIASOUP_VERSION` and points `MEDIASOUP_WORKER_BIN` at it, and fails the build when the installed mediasoup version differs.
