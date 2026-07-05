# nginx 反向代理（可选）

**默认内网 HTTP 直连 22000 端口即可，本配置是可选增强。**

## 何时需要

- 想统一 HTTPS 入口（自签证书，内网信任）
- 多个服务共用 80/443
- 想加额外的安全 headers / 上传大小限制 / 限速

## 接入方式（两种任选其一）

### 方式 A：宿主机 nginx

把 `nginx.conf` 复制到 `/etc/nginx/conf.d/da-hub.conf`，证书放 `/etc/nginx/certs/`，重载 nginx。

### 方式 B：独立 nginx 容器

在 `docker-compose.prod.yml` 同级追加一个服务（保持 Hub 仍监听 22000，nginx 监听 443）：

```yaml
  nginx:
    image: nginx:1.27-alpine
    container_name: da-hub-nginx
    restart: unless-stopped
    ports:
      - "443:443"
      - "80:80"
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/conf.d/da-hub.conf:ro
      - ./secrets/certs:/etc/nginx/certs:ro
    depends_on:
      - hub
```

> 注意：`nginx.conf` 中 `upstream` 指向 `127.0.0.1:22000` 适合「方式 A」；用「方式 B」时改为 `hub:22000`（容器网络内服务名）。

## 生成自签证书

```bash
mkdir -p ./secrets/certs
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout ./secrets/certs/hub.key \
  -out    ./secrets/certs/hub.crt \
  -subj "/CN=hub.internal"
```

> 客户端浏览器会提示「不安全」，这是因为自签证书无公信 CA 背书。内网部署时可让用户手动信任，或换成内网 CA 签发的证书。
