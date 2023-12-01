FROM node:16

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
# A wildcard is used to ensure both package.json AND package-lock.json are copied
# where available (npm@5+)
COPY package*.json ./

# Download, and prepare the kepubify binary
RUN wget https://github.com/pgaskin/kepubify/releases/download/v4.0.4/kepubify-linux-64bit
RUN mv kepubify-linux-64bit /usr/local/bin/kepubify
RUN chmod +x /usr/local/bin/kepubify

COPY . .

EXPOSE 3001
CMD [ "node", "index" ]
