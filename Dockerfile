# 使用官方Node.js镜像作为基础镜像
FROM node:14

# 设置工作目录
WORKDIR /usr/src/app

# 将项目文件复制到容器中
COPY . .

# 安装项目依赖
RUN npm install

# 暴露端口，假设应用监听在3000端口
EXPOSE 3000

# 定义容器启动后执行的命令
CMD ["node", "index.js"]
