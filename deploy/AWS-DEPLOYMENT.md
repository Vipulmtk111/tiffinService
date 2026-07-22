# Tiffin Bot AWS Ubuntu Deployment

This document describes a safe deployment process for `tiffin-bot` onto an Ubuntu AWS server using `nginx` + `certbot`.

## Requirements from your side

1. **Ubuntu server access**
   - Public IP or hostname
   - SSH user (typically `ubuntu`)
   - SSH key or password
2. **Domain name**
   - A DNS A record pointing to the server IP
   - The domain/subdomain you want to use for the bot
3. **Current `.env` file**
   - The production environment values already in your workspace
   - We will use the same file exactly
4. **Confirm no conflicting ports**
   - Confirm that the server is safe to use ports `80` and `443`
   - Existing services should remain operational

## Deployment strategy

- Use PM2 to run `src/index.js`
- Use nginx as a reverse proxy for `http://127.0.0.1:3000`
- Use certbot to provision HTTPS certificates
- Preserve existing services by using a separate nginx site file and only reloading nginx after validation

## Preparation steps

1. Copy repository to server
2. Ensure Node 20 / npm / pm2 / nginx / certbot installed
3. Place `.env` in the repo root and verify its content
4. Start the bot using PM2 with the existing ecosystem config
5. Create a dedicated nginx server block for the bot
6. Obtain HTTPS certs with certbot
7. Validate the bot health URL and webhook callback URL

## Required data

- Server IP or hostname
- SSH connection method (key file path or password)
- Domain name to use for the production URL
- `.env` file contents if not already on the server
- Whether the server has an existing nginx configuration

## Safe deployment notes

- Do not change any existing nginx server blocks except by adding a new site file
- Use `nginx -t` before reload
- Use `pm2` to manage the Node process and leave it isolated from other services
- If you are unsure about existing service ports, we can choose a non-conflicting app domain/subdomain or path
