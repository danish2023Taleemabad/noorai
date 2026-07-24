# Debian/glibc base (NOT Alpine/musl) — @roamhq/wrtc ships prebuilt glibc binaries.
FROM node:22-bookworm

WORKDIR /app

# Install deps first (better layer caching). npm ci installs devDeps too (tsx),
# which we use to run the TypeScript entrypoint.
COPY package*.json ./
RUN npm ci

COPY . .

ENV NODE_ENV=production
# Railway injects PORT at runtime; the app binds to it (defaults to 8080 locally).
EXPOSE 8080

CMD ["npm", "start"]
