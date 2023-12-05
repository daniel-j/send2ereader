FROM node:20

# Create app directory
WORKDIR /usr/src/app

# Copy app files (see .dockerignore)
COPY . ./

# Install app dependencies
RUN npm install --omit=dev

# Download and install kepubify
RUN wget https://github.com/pgaskin/kepubify/releases/download/v4.0.4/kepubify-linux-64bit && \
    mv kepubify-linux-64bit /usr/local/bin/kepubify && \
    chmod +x /usr/local/bin/kepubify

# Download and install kindlegen
RUN wget https://archive.org/download/kindlegen2.9/kindlegen_linux_2.6_i386_v2_9.tar.gz && \
    mkdir kindlegen && \
    tar xvf kindlegen_linux_2.6_i386_v2_9.tar.gz --directory kindlegen && \
    cp kindlegen/kindlegen /usr/local/bin/kindlegen && \
    chmod +x /usr/local/bin/kindlegen && \
    rm -rf kindlegen

# Create uploads directory if it doesn't exist
RUN mkdir uploads

EXPOSE 3001
CMD [ "npm", "start" ]
