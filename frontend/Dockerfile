FROM node:20-alpine
WORKDIR /app
COPY . .
ENV PORT=5173
# 정적 파일만 읽어 내보낸다. 쓰는 것이 없으므로 root 로 돌 이유가 없다.
USER node
EXPOSE 5173
CMD ["node", "server.js"]
