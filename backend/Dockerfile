FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx prisma generate && npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh
EXPOSE 8080
# 마이그레이션 실행 여부는 entrypoint 가 RUN_MIGRATIONS_ON_START 로 정한다.
# 여러 대가 동시에 뜨는 환경에서는 꺼 두고 배포 단계에서 한 번만 돌린다.
CMD ["./docker-entrypoint.sh"]
