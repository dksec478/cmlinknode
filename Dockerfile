FROM mcr.microsoft.com/playwright:v1.47.0-jammy
WORKDIR /app
COPY . .
RUN npm install
CMD ["npm", "start"]