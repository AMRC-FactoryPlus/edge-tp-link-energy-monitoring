FROM node:19.9.0-slim
WORKDIR /app
COPY package*.json .
COPY app.js app.js
RUN npm install
COPY ./config/config.json.example ./config/config.json
CMD ["node", "app.js"]
