# Runs anywhere that takes a container: Render, Fly, Railway, Cloud Run, a VPS.
# No dependencies to install, so there is nothing to cache and no build step.
FROM node:20-alpine

WORKDIR /app
COPY . .

# The hall state lives here. Mount a VOLUME at this path on any host whose
# filesystem resets between restarts, or a restart loses the night.
RUN mkdir -p /app/data
VOLUME ["/app/data"]

# The host supplies PORT; 8400 is only the local default.
ENV PORT=8400
EXPOSE 8400

# MIRROR_ADMIN_KEY must be set at run time. It guards banish, wipe, and the
# lead export. Never bake it into an image.
CMD ["node", "server.mjs"]
