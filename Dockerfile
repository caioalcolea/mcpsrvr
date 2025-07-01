# Use a imagem base oficial do Node.js
FROM node:18-alpine

# Crie e defina o diretório de trabalho
WORKDIR /app

# Copie o package.json para o diretório de trabalho
# O asterisco em package*.json garante que o package-lock.json também seja copiado
COPY package*.json ./

# Instale as dependências da aplicação
# --omit=dev para não instalar dependências de desenvolvimento
RUN npm install --omit=dev --silent

# Copie o resto do código da sua aplicação
COPY . .

# Exponha a porta que a aplicação vai rodar
EXPOSE 3010

# Comando para iniciar a aplicação
CMD [ "node", "server.js" ]