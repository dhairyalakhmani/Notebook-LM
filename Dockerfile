# Node 24 is a requirement, not a preference: the server runs .ts files directly
# (no build step) and uses the built-in node:sqlite. Node 22 cannot do either.

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json ./web/
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-slim
WORKDIR /app

ENV NODE_ENV=production
ENV NOTEBOOK_STORAGE_DIR=/data

COPY package.json package-lock.json ./
COPY web/package.json ./web/
# Optional dependencies are KEPT: pdfjs-dist declares @napi-rs/canvas as one,
# and its Node build touches DOMMatrix at module scope, so omitting it makes
# PDF text extraction crash on import rather than degrade.
#
# The ~600 MB that is genuinely unused is pruned by name instead:
# @huggingface/transformers and its two onnxruntime builds are needed only
# when EMBEDDING_PROVIDER is "local" or the reranker is on, and both are
# lazily imported, so nothing loads them in the default hf-api setup.
RUN npm ci --omit=dev \
    && rm -rf \
        node_modules/@huggingface \
        node_modules/onnxruntime-node \
        node_modules/onnxruntime-web \
    && npm cache clean --force

COPY src/ ./src/
COPY main.ts ./
COPY --from=build /app/web/dist ./web/dist

# The three SQLite files and the ingested originals. Mount a persistent volume
# here or every notebook disappears when the container is replaced.
RUN mkdir -p /data/sources /data/tmp

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "const p=process.env.PORT||8787;fetch('http://127.0.0.1:'+p+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 0.0.0.0 because the default bind is loopback, which a container cannot serve
# from. PORT is read because most hosts inject it.
CMD ["sh", "-c", "node --disable-warning=ExperimentalWarning src/api/server.ts --static web/dist --host 0.0.0.0 --port ${PORT:-8787}"]
