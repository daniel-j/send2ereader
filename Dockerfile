FROM node:20-alpine

# Create app directory
WORKDIR /usr/src/app

# Download and install kepubify
RUN wget https://github.com/pgaskin/kepubify/releases/download/v4.0.4/kepubify-linux-64bit && \
    mv kepubify-linux-64bit /usr/local/bin/kepubify && \
    chmod +x /usr/local/bin/kepubify

# Download and install kindlegen
RUN wget https://web.archive.org/web/20150803131026if_/https://kindlegen.s3.amazonaws.com/kindlegen_linux_2.6_i386_v2_9.tar.gz && \
    mkdir kindlegen && \
    tar xvf kindlegen_linux_2.6_i386_v2_9.tar.gz --directory kindlegen && \
    cp kindlegen/kindlegen /usr/local/bin/kindlegen && \
    chmod +x /usr/local/bin/kindlegen && \
    rm -rf kindlegen

# Copy files needed by npm install
COPY package*.json ./

# Install app dependencies
RUN npm install --omit=dev

# Copy the rest of the app files (see .dockerignore)
COPY . ./

# Create uploads directory if it doesn't exist
RUN mkdir uploads

EXPOSE 3001
CMD [ "npm", "start" ]
