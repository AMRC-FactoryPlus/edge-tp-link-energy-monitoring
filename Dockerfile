FROM node:19.9.0-slim
WORKDIR /app
COPY package*.json .
RUN npm install
COPY . .
COPY /config/config.json.example /config/config.json
CMD ["node", "app.js"]
