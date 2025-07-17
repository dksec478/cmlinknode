FROM mcr.microsoft.com/playwright:v1.54.1-jammy
WORKDIR /app
COPY . .
RUN npm install -g npm@11.4.2
RUN npm install
CMD ["npm", "start"]