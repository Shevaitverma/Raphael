FROM node:20-slim
WORKDIR /app

# Deps first for layer caching. No package-lock committed for this tiny service,
# so fall back to `npm install` when the lockfile is absent.
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY src ./src

CMD ["node", "src/index.js"]
