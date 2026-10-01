FROM registry.access.redhat.com/ubi9/nodejs-22:latest
WORKDIR /opt/app-root/src
COPY --chown=1001:0 package.json server.mjs ./
COPY --chown=1001:0 public ./public
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
EXPOSE 8080
USER 1001
CMD ["node", "server.mjs"]
