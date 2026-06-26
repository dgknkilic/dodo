# Dodo — VPS Kurulum Kılavuzu

## Gereksinimler
- Ubuntu/Debian VPS (512MB RAM yeterli)
- Node.js 18+ 
- Nginx (SSL için)
- Alan adı veya IP adresi

---

## 1. Node.js Kur

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

---

## 2. Dosyaları Yükle

```bash
# Sunucuya kopyala
scp -r . kullanici@sunucu-ip:/home/kullanici/dodo

# VEYA git ile:
git clone https://github.com/kullanici/dodo.git
cd dodo
npm install --production
```

---

## 3. Ortam Değişkenlerini Ayarla

```bash
cp .env.example .env
nano .env
```

`.env` içeriği:
```
PORT=3000
JWT_SECRET=guvenli-rastgele-uzun-bir-sifre-buraya
DB_PATH=/home/kullanici/dodo/dodo.db
```

> **ÖNEMLİ**: JWT_SECRET en az 32 karakter, rastgele olmalı!
> Üretmek için: `openssl rand -hex 32`

---

## 4. PM2 ile Çalıştır (Otomatik Başlatma)

```bash
sudo npm install -g pm2
pm2 start server.js --name dodo
pm2 startup
pm2 save
```

---

## 5. Nginx + SSL Ayarla (HTTPS ZORUNLU)

> WebRTC mikrofon ve ekran paylaşımı için HTTPS şarttır!

### Nginx kur:
```bash
sudo apt install nginx certbot python3-certbot-nginx -y
```

### Nginx config (`/etc/nginx/sites-available/dodo`):
```nginx
server {
    server_name siteadiniz.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/dodo /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx

# SSL sertifikası al (ücretsiz):
sudo certbot --nginx -d siteadiniz.com
```

---

## 6. Güvenlik Duvarı

```bash
sudo ufw allow 22    # SSH
sudo ufw allow 80    # HTTP
sudo ufw allow 443   # HTTPS
sudo ufw enable
```

---

## 7. NAT Arkasındaki Kullanıcılar İçin TURN Sunucusu (İsteğe Bağlı)

Eğer bazı kullanıcılar bağlanamıyorsa TURN sunucusu gerekebilir:

```bash
sudo apt install coturn -y
```

`/etc/turnserver.conf`:
```
listening-port=3478
fingerprint
use-auth-secret
static-auth-secret=gizli-turn-sifreniz
realm=siteadiniz.com
total-quota=100
bps-capacity=0
stale-nonce
no-multicast-peers
```

```bash
sudo systemctl enable coturn
sudo systemctl start coturn
```

Sonra `.env` dosyasına ekle:
```
TURN_URL=turn:siteadiniz.com:3478
TURN_USERNAME=kullanici
TURN_CREDENTIAL=sifre
```

Ve `public/webrtc.js` içindeki `iceServers` dizisine:
```javascript
{ 
  urls: 'turn:siteadiniz.com:3478',
  username: 'kullanici',
  credential: 'sifre'
}
```

---

## Kullanım

1. Tarayıcıdan `https://siteadiniz.com` adresine git
2. Hesap oluştur
3. Sol menüden metin kanalına tıklayarak sohbet et
4. Sesli kanala tıklayıp "Sese Katıl" ile sesli görüşmeye başla
5. "Ekran Paylaş" ile ekranını paylaş

---

## Güncelleme

```bash
cd /home/kullanici/dodo
git pull
npm install --production
pm2 restart dodo
```
