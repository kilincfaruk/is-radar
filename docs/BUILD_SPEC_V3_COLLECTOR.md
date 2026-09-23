# İş Radar v3 — Hesapsız Toplayıcı (Build Spec)

> **Not (2026-09-18):** v2 extension'ı kaldırıldı, repo tek pakete indirildi (kök: `src/`, `dashboard/`,
> `profile/`, `test/`). Aşağıdaki yapı/klasör adları tarihî tasarım notudur; güncel düzen için `README.md`.
>
> v2 extension'ı (`is-radar/`) yerinde kalır, opsiyonel besleyici olur. Ana sistem
> artık lokal bir Node servisi: LinkedIn'e **login olmadan**, kullanıcının hesabıyla
> hiçbir bağı olmadan, misafir uçlarından toplar; kural motoru + Claude ile eler;
> aynı dashboard'u localhost'ta sunar. Scoring kuralları v1/v2'den aynen.

## 0. Neden v3

- v2 üç gün manuel gezmeye rağmen 257 ilanın 82'sinde metin toplayabildi; DOM ve
  arayüz değişkenliği (klasik Ember / yeni React SDUI) sürekli kırıldı.
- Kullanıcının hesabıyla otomasyon (Playwright + şifre) hesabı riske atar, kabul
  edilmedi. Misafir uçları hesapsızdır: engellenirse IP engellenir, hesap değil.
- 2026-09-16'da doğrulandı: `jobs-guest/.../seeMoreJobPostings/search` 200 (25-30
  kart), `jobs-guest/jobs/api/jobPosting/<id>` 200 (tam description + kriterler).

## 1. Değişmez kararlar

- LinkedIn'e login YOK, cookie YOK, Playwright YOK. Sadece düz HTTPS GET, misafir uçları.
- Nazik tempo: istekler arası 4-9 sn randomize, saatte en fazla ~250 istek, 429/999
  görünce üstel geri çekilme (5 dk → 15 → 45), günde tavan. Kullanıcının ev/ofis
  bağlantısından çalışır, proxy/VPN döndürme YOK.
- Backend yok, deploy yok: her şey `localhost`. Veri SQLite (`data/is-radar.db`).
- Claude çağrısı sadece Anthropic API (key varsa). Key yoksa kural motoru + chat
  paketi (v2'deki manuel akış) çalışmaya devam eder. "Şirket araştırması" key gerektirir.

## 2. Yapı

```
collector/                     # Node 22, TypeScript, tek paket
  src/
    index.ts                   # CLI: `run` (tek tur), `serve` (scheduler + web)
    config.ts                  # .env + searches.yaml
    sources/
      linkedin-guest.ts        # arama listesi + detay parser
      (kariyernet.ts)          # v3.1
    pipeline/
      prescreen.ts             # v2 ile ORTAK modül (is-radar/src/shared/prescreen.ts)
      score.ts                 # Claude structured output, v2 prompt aynen
      research.ts              # şirket araştırması (web_search tool), key gerekli
    db/
      schema.sql, repo.ts      # better-sqlite3
    web/
      server.ts                # Fastify: REST + statik dashboard
  dashboard/                   # v2 dashboard'un aynısı, db.ts yerine fetch('/api/…')
  searches.yaml                # kullanıcının aramaları
  .env.example                 # ANTHROPIC_API_KEY=, TELEGRAM_BOT_TOKEN= (ops.), TELEGRAM_CHAT_ID=
```

Tek komut: `npm run serve` → scheduler + `http://localhost:4545`. İleride `node --experimental-sea`
ile tek `.exe`; önce çalışsın.

## 3. Aramalar (`searches.yaml`)

```yaml
defaults:
  location: "Türkiye"
  # f_WT yok: misafir uç noktası çalışma şekli filtresini yok sayar (doğrulandı), etiket de vermez
  f_TPR: r604800       # son 7 gün; ilk turda r2592000 (30 gün)
  max_pages: 8         # 8 × 25 = 200 ilan / arama
searches:
  - keywords: "business analyst"
  - keywords: "iş analisti"
  - keywords: "product owner"
  - keywords: "ürün sahibi"
  - keywords: "product manager"
  - keywords: "ürün yöneticisi"
  - keywords: "product analyst"
  - keywords: "sistem analisti"
  - keywords: "solution consultant"
schedule: "every 3h"    # 06:00-23:00 arası
```

## 4. Kaynak: LinkedIn misafir uçları

- Liste: `GET https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=…&location=…&f_TPR=r604800&start=0|25|50…` (f_WT gönderilmez: misafir uç noktası onu yok sayar ve çalışma şekli etiketi döndürmez; çalışma şekli ilan metninden çıkarılır)
  Yanıt HTML: `li > div.base-card[data-entity-urn="urn:li:jobPosting:<id>"]`,
  `.base-search-card__title`, `.base-search-card__subtitle` (şirket + `/company/` linki),
  `.job-search-card__location`, `time.job-search-card__listdate[datetime]`.
  Boş liste / <5 kart → sayfalama biter.
- Detay: `GET https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/<id>`
  `.top-card-layout__title`, `.topcard__org-name-link`, `.topcard__flavor--bullet`
  (lokasyon), `.num-applicants__caption`, `.show-more-less-html__markup` (description
  HTML → markdown, v2 `markdown.js` mantığı), `.description__job-criteria-item`
  (Seniority level / Employment type / Job function / Industries → ayrı kolonlar).
- Header'lar: gerçek tarayıcı UA, `Accept-Language: tr-TR`. Başka hiçbir şey.
- Selector kırılırsa: HTML örneği `data/samples/` altına yazılır, log'a uyarı, tur durmaz.

## 5. Veri modeli (SQLite)

`jobs` tablosu v2 `Job` tipiyle birebir + eklemeler:

| kolon | tip | not |
|---|---|---|
| linkedin_job_id | TEXT PK | |
| source | TEXT | `linkedin-guest` / `extension` / `kariyernet` |
| search_keywords | TEXT | hangi aramadan geldi (ilk) |
| criteria_seniority / criteria_employment / criteria_function / criteria_industry | TEXT | detay sayfası kriterleri |
| description_md, description_fetched_at | | |
| pre_verdict, pre_score, pre_json | | kural motoru çıktısı (yeniden hesaplanabilir) |
| score, remote_verified, seniority_fit, role_fit, summary, pros_json, cons_json, red_flags_json, scored_at, score_model, score_error | | v2 aynı |
| company_research_md, company_research_at | TEXT | Claude web araştırması özeti |
| status, notes, applied_at | | kullanıcı alanları, asla ezilmez |
| first_seen_at, last_seen_at, seen_count | | seen = arama listesinde görülme |

`runs` tablosu: tur başlangıç/bitiş, istek sayısı, 429 sayısı, yeni ilan, yeni metin, hata.

Indexler: `score`, `pre_score`, `status`, `first_seen_at`, `description_fetched_at IS NULL`.

## 6. Pipeline (her tur)

1. Her arama için sayfaları çek, kartları upsert et (`seen_count++`, metadata sadece boşsa/yeniyse).
2. Description'ı olmayan ilanları `first_seen_at` DESC sırayla detaydan çek (tur başına tavan 120).
3. Metni gelen her ilana `prescreen` çalıştır (v2 modülü aynen), `pre_*` yaz.
4. Key varsa: `pre_verdict != reject` olanları Claude ile skorla (v2 prompt, structured
   output, concurrency 3). `reject` olanlara skor harcanmaz; kullanıcı dashboard'dan
   "yine de skorla" diyebilir.
5. Key varsa ve skor ≥ eşik (varsayılan 60): şirket araştırması — Claude + `web_search`
   tool: şirketin ne yaptığı, büyüklüğü, Türkiye ofisi, remote politikası hakkında
   çevrimiçi kanıt, Glassdoor/Kariyer.net yorumlarından öne çıkan şikayetler, ilanın
   şirket sitesinde de olup olmadığı. 150-250 kelime Türkçe, kaynak linkleriyle.
   LinkedIn'e istek YOK (şirket sayfası çekilmez).
6. Bildirim (ops.): yeni ≥80 ilan → Telegram mesajı (başlık, şirket, skor, link). Yoksa sadece dashboard.

## 7. Dashboard

v2 dashboard'un aynısı (tablo, filtreler, ön eleme rozetleri, detay, notlar, ön yazı,
chat paketi export/import), veri kaynağı `/api`. Eklemeler: `runs` özeti ("son tur:
14:00, 9 arama, 212 kart, 41 yeni, 38 metin, 0 hata"), şirket araştırması paneli,
"yine de skorla" ve "araştır" butonları, `searches.yaml` düzenleme (form).

## 8. Extension (v2) ile ilişki

Extension kalır; `JOBS_BATCH`'i localhost:4545'e de POST eder (`host_permissions`'a
`http://localhost:4545/*`). Kullanıcı LinkedIn'de gezerken gördüğü ilanlar da aynı
DB'ye düşer. Extension'ın kendi IndexedDB'si ve dashboard'u kaldırılmaz ama
"legacy" olur. Mevcut 257 ilanlık backup JSON'u v3'e import edilir (`npm run import -- backup.json`).

## 9. Kabul kriterleri

1. `npm run run` tek turda 9 aramayı gezer, ≥150 kart toplar, 429 almadan ≥100 description çeker (ev bağlantısı).
2. Aynı ilan ikinci turda yeni satır açmaz, `seen_count` artar; metin bir kez çekilir.
3. Metni gelen her ilan `pre_verdict` alır; "haftada 2 gün ofis" geçen ilan `reject` ve `pre_score ≤ 25`.
4. Key varken `reject` olmayanlar skorlanır; JSON hatası turu düşürmez.
5. Key yokken dashboard "Claude chat ile skorla" paketi üretir ve JSON'u geri alır.
6. 429 gelince tur durmaz, geri çekilir, `runs` tablosuna yazılır, dashboard'da görünür.
7. Backup import 257 ilanı kayıpsız getirir (status/notes dahil).
8. Selector kırılınca örnek HTML kaydedilir, log net, diğer aramalar devam eder.

## 10. Yapılmayacaklar

LinkedIn login/cookie/Voyager, Playwright, proxy döndürme, Easy Apply, çoklu kullanıcı, deploy.
