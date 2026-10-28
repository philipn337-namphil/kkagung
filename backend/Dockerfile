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
# npm 캐시는 설치할 때만 쓰인다. 같은 레이어에서 지우지 않으면 /root/.npm 이
# 그대로 이미지에 남는다. 받아오는 쪽에서는 그만큼 기동이 늦어진다.
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh
# 애플리케이션은 파일을 쓰지 않는다. 업로드도 메모리에서 처리해 저장소로 바로 보낸다.
# root 로 돌 이유가 없고, 컨테이너를 벗어나는 취약점의 영향을 줄인다.
USER node
EXPOSE 8080
# 마이그레이션 실행 여부는 entrypoint 가 RUN_MIGRATIONS_ON_START 로 정한다.
# 여러 대가 동시에 뜨는 환경에서는 꺼 두고 배포 단계에서 한 번만 돌린다.
CMD ["./docker-entrypoint.sh"]
