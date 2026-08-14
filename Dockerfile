# Déploiement Fly.io — deux étapes : build du dashboard (Vite), puis runtime Node.
# Le backend (express + node:sqlite) sert l'API ET le dashboard statique à `/`.

# Étape 1 : build du dashboard statique.
FROM node:24-alpine AS dashboard-build
WORKDIR /app/dashboard
COPY dashboard/package.json dashboard/package-lock.json ./
RUN npm ci
COPY dashboard/ ./
RUN npm run build

# Étape 2 : runtime.
FROM node:24-alpine
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev
COPY backend/ ./
COPY --from=dashboard-build /app/dashboard/dist ../dashboard/dist
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "index.mjs"]
