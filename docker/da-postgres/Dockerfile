# da-postgres:16-tuned
# DeepAnalyze worker 专用 PG 镜像，基于官方 postgres:16-alpine + 调优配置 + healthcheck
# 用法: docker build -t da-postgres:16-tuned .
#       docker push ${REGISTRY}da-postgres:16-tuned

FROM postgres:16-alpine

# 调优配置（覆盖默认）
COPY postgresql-tuned.conf /etc/postgresql/postgresql.conf

# Healthcheck 脚本
COPY pg-healthcheck.sh /usr/local/bin/pg-healthcheck.sh
RUN chmod +x /usr/local/bin/pg-healthcheck.sh

# 每 10 秒检查一次，超 3 秒 timeout，连续 5 次失败才 unhealthy
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=5 \
  CMD ["pg-healthcheck.sh"]

# 覆盖 CMD 用调优配置启动
CMD ["postgres", "-c", "config_file=/etc/postgresql/postgresql.conf"]
