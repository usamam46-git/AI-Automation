# Deploying to a single VPS

Production stack: `infra/docker-compose.prod.yml`. Read it before running it —
the header explains how it differs from the development compose and why the
`internal` network is not applied the way Vol. 6 §1's snippet shows.

Everything below runs **from the `infra/` directory on the server**.

```sh
cd infra
alias dc='docker compose -f docker-compose.prod.yml --env-file .env.prod'
```

---

## 0. Prerequisites

- A VPS. Vol. 6 §4's sizing for 0–1,000 users is 8 vCPU / 32 GB / NVMe. The
  stack will run on far less; Postgres + pgvector and the three Celery pools are
  what consume it, not the proxy.
- **A DNS A record pointing at the VPS, resolving before you start.** Let's
  Encrypt validates by fetching over HTTP from the public internet; issuance
  fails if DNS is not live yet.
- Docker Engine + the Compose plugin.
- A firewall allowing **only 22, 80 and 443**. Nothing else needs to be
  reachable — the compose file publishes no other port, but a firewall is the
  layer that survives someone adding one later.

  ```sh
  ufw default deny incoming && ufw allow 22 && ufw allow 80 && ufw allow 443 && ufw enable
  ```

## 1. Configure

```sh
cp .env.prod.example .env.prod
```

Fill in every uncommented variable. Generate the secrets **on this machine**:

```sh
openssl rand -hex 32     # SECRET_KEY
openssl rand -hex 32     # JWT_SECRET_KEY   (a different value)
openssl rand -base64 32  # INTEGRATION_ENCRYPTION_KEY
openssl rand -hex 24     # POSTGRES_PASSWORD
openssl rand -hex 24     # MINIO_ACCESS_KEY / MINIO_SECRET_KEY
```

There are no defaults. `dc config` fails and names any variable you missed —
that is deliberate, and the reason is in `.env.prod.example`.

**Back up `INTEGRATION_ENCRYPTION_KEY` somewhere your database backups are not.**
Losing it is equivalent to losing every stored BYOK key, tool credential and
webhook secret; rotating it destroys them rather than degrading them.

Sanity check before going further:

```sh
dc config >/dev/null && echo OK
```

## 2. Generate the nginx config

The committed file is a template so the repository carries no hostname.

```sh
export DOMAIN=your.domain
envsubst '$DOMAIN' < nginx/orkest.conf.template > nginx/conf.d/orkest.conf
```

The `'$DOMAIN'` allow-list is not optional — without it envsubst also replaces
`$host`, `$remote_addr` and `$request_uri` with empty strings, producing a
config that loads cleanly and routes everything to the wrong place.

No `envsubst` (it ships in `gettext`)? This is equivalent:

```sh
sed "s|\${DOMAIN}|$DOMAIN|g" nginx/orkest.conf.template > nginx/conf.d/orkest.conf
```

Confirm the substitution and that nginx's own variables survived:

```sh
grep -E 'server_name|ssl_certificate |\$host' nginx/conf.d/orkest.conf
```

## 3. Break the certificate chicken-and-egg

nginx refuses to start when `ssl_certificate` names a file that does not exist,
and certbot's webroot challenge needs a running nginx to answer it. This is the
single most common place a first deploy stalls.

Resolve it by starting nginx on a throwaway self-signed certificate, then
replacing it. **Do not** comment the TLS block out and back in — a half-edited
config is harder to recover from than a temporary certificate.

```sh
docker run --rm -v "$PWD/certbot/conf:/etc/letsencrypt" --entrypoint sh certbot/certbot -c \
  "mkdir -p /etc/letsencrypt/live/$DOMAIN && \
   openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
     -keyout /etc/letsencrypt/live/$DOMAIN/privkey.pem \
     -out    /etc/letsencrypt/live/$DOMAIN/fullchain.pem -subj '/CN=$DOMAIN'"
```

## 4. Build and start

```sh
dc up -d --build
```

Watch `migrate` run to completion — the API and workers do not start until it
exits 0:

```sh
dc logs migrate
dc ps
```

Browsers will show a certificate warning at this point. That is the dummy.

## 5. Issue the real certificate

Discard the placeholder first, or certbot treats it as an existing lineage:

```sh
docker run --rm -v "$PWD/certbot/conf:/etc/letsencrypt" --entrypoint sh certbot/certbot -c \
  "rm -rf /etc/letsencrypt/live/$DOMAIN /etc/letsencrypt/archive/$DOMAIN /etc/letsencrypt/renewal/$DOMAIN.conf"

dc run --rm --entrypoint certbot certbot certonly \
  --webroot -w /var/www/certbot -d "$DOMAIN" \
  --email "$ACME_EMAIL" --agree-tos --no-eff-email
```

`--entrypoint certbot` is required: the `certbot` service's own entrypoint is
the twice-daily renewal loop, and without the override it ignores these
arguments and starts looping instead of issuing.

Then pick it up:

```sh
dc exec nginx nginx -s reload
```

Renewal from here is automatic — certbot retries twice daily and nginx reloads
every six hours to notice a new file. Confirm the machinery, not just the cert:

```sh
dc run --rm --entrypoint certbot certbot renew --dry-run
```

## 6. Verify

Each step catches a specific failure that is otherwise quiet.

```sh
# Datastores are not internet-reachable. Run this from ANOTHER machine.
nc -zv $DOMAIN 5432 6379 9000 9001    # all four must be refused/filtered
nc -zv $DOMAIN 443                    # must connect

curl -sI  http://$DOMAIN | head -1                 # 301 to https
curl -s   https://$DOMAIN/health                   # {"status":"ok","env":"production"}
```

Then, in a browser:

1. **Routing.** `POST https://$DOMAIN/api/contact` must reach Next.js — 503 with
   no `CONTACT_WEBHOOK_URL`, 200 with one. A FastAPI 404 here means the proxy
   prefix was widened from `/api/v1/` to `/api/` and the contact form is broken.
2. **Session.** Register, log in, hard-refresh. Surviving the refresh proves the
   `Secure; SameSite=Strict` cookie is set and that the silent refresh works
   against a production CORS allow-list that is empty by design.
3. **Uploads.** Ingest a ~5 MB PDF into a knowledge base and let it reach
   `indexed`. At nginx's 1 MB default this 413s; the config sets 24 MB. Then
   confirm a >24 MB file is refused.
4. **Invitations.** Invite a member. The `accept_url` must be
   `https://$DOMAIN/accept-invite?token=…`. `localhost` means `FRONTEND_URL` is
   unset — the one variable whose omission fails silently.
5. **Frontend wiring.** On `/dashboard`, confirm XHRs go to
   `https://$DOMAIN/api/v1/…`. A call to `http://localhost:8000` means the web
   image was built without the `NEXT_PUBLIC_API_URL` build arg. That value is
   inlined at build time — fix it with `dc build web`, not a restart.
6. **The whole loop, through real workers.**

   ```sh
   dc exec api python -m src.db.demo.seed --email you@example.com
   dc exec api python -m src.db.demo.send_invoice --base-url https://$DOMAIN
   ```

   Signed webhook → agent → retrieval → approval gate → approve → mock ERP write
   → `completed`. This exercises beat, `worker_workflow`, and proves nginx did
   not alter the raw request body the HMAC is computed over.

7. **CSP.** It ships as `Content-Security-Policy-Report-Only`. Load the landing
   page and the builder, read the console violations, and only then consider
   renaming the header to `Content-Security-Policy`. The landing page uses
   WebGL and GSAP-injected inline styles; an enforced policy written blind
   breaks it.

## 7. Routine operations

```sh
dc logs -f api worker_workflow      # tail
dc ps                               # health
dc up -d --build                    # deploy current checkout
dc exec postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip > backup-$(date +%F).sql.gz
```

A deploy recreates the app containers with new IPs. nginx handles that without a
reload because the config resolves upstreams through a variable rather than an
`upstream {}` block — see the comment at the top of the template before
"simplifying" it back.

## Not set up here

- **Backups are a manual `pg_dump` above.** A production database holding
  encrypted customer credentials with no scheduled off-host backup is the
  largest remaining gap; it is the next thing to do after this stack is up.
- CI/CD (Vol. 6 §3) — deploy is `git pull && dc up -d --build` for now.
- API replicas (Vol. 6 §4). The one-shot `migrate` service is the precondition;
  add an `upstream` with two api instances once one is proven stable.
- Prometheus / Grafana / Sentry (Vol. 6 §5).
