# 1. Imagem Base
FROM node:18-alpine

# 2. Diretório de Trabalho
WORKDIR /app

# 3. Copiar arquivos de dependências
# O asterisco copia tanto package.json quanto package-lock.json
COPY package*.json ./

# 4. Instalar dependências de produção
RUN npm install --omit=dev --silent

# 5. Copiar o resto do código da aplicação
COPY . .

# 6. Expor a porta que a aplicação usa
EXPOSE 3010

# 7. Comando padrão para iniciar o container
CMD [ "node", "server.js" ]
