# İş Radar

> **EN:** A local, login-free LinkedIn job radar for job seekers in Türkiye: collects postings from LinkedIn's
> guest endpoints, prescreens them with a rule engine, scores them against *your* CV and criteria with Claude
> (`claude -p`, no API key needed on a Max plan), and serves a keyboard-driven triage dashboard on localhost.
> Built for Business Analyst / Product Owner / Product Manager searches; the role dictionaries live in
> `src/shared/prescreen.ts`. Everything personal (CV, criteria, searches) stays in gitignored files.

LinkedIn iş ilanlarını **hesapsız, login'siz** toplayan, kural motoru + Claude ile skorlayan, sonuçları lokal
bir dashboard'da gösteren tek kişilik iş radarı. Backend yok, deploy yok: her şey `localhost`, veri SQLite.

- **Toplama:** LinkedIn'in misafir uçlarına düz `GET` (arama listesi + ilan sayfası). Cookie, Playwright, Voyager yok.
  4-9 sn aralık, saatte ≤250 istek, 429'da geri çekilme. Engellenirse IP engellenir, hesap değil.
- **Ön eleme:** kural motoru (`src/shared/prescreen.ts`): başlık kapısı, çalışma şekli, şehir, rol, kıdem → `candidate / review / reject`.
- **Skorlama:** `claude -p` (Claude Code CLI, Max aboneliği; API key gerekmez). Claude ilanı okuyup olguları
  (çalışma şekli, kıdem, İngilizce, maaş, çalışma tipi, ajans/vardiya) ve tek bir **içerik uyumu** (fit, 0-100) verir;
  nihai skoru kod hesaplar (`src/shared/scoring.ts`). Detayda döküm görünür ("71 içerik uyumu · +10 tam remote · −10
  kıdem"), ağırlıklar Ayarlar'dan ya da `radar.score_weights`'ten değişir ve eski skorlar LLM'siz yeniden hesaplanır.
  Sınır bandındaki ilanları ikinci model (Opus) bir daha okur, iki okuma **birleştirilir** (fit ortalaması, olgularda
  çoğunluk). İsteğe bağlı web araştırmasıyla şirket notu çıkarır, ön yazı üretir.
- **Kararlarından öğrenme:** 30+ shortlist/yoksay kararından sonra skoru senin tercihlerine göre düzelten küçük bir
  model (logistic regression) kurulur; çapraz doğrulamada skordan iyi sıralıyorsa listede "%" ve "sana göre" sıralaması
  açılır, Sistem sekmesi hangi olguyu skorun söylediğinden çok/az sevdiğini yazar.
- **Şirket panoları:** `searches.yaml` → `companies:` ile Greenhouse / Lever / Ashby kariyer panoları doğrudan izlenir
  (herkese açık JSON, login yok). Panodan kalkan ilan "kapandı" olur.
- **Dashboard:** React, `http://localhost:4545`. Gelenler (kuyruklar + filtreler + klavyeyle triage), Shortlist, Sistem (turlar, süre/maliyet grafiği, canlı log, LinkedIn durumu), Ayarlar (eşik, aramalar, CV incelemesi, masaüstü bildirimi). URL hash görünümü/ilanı taşır, paylaşılabilir.
- **CV araçları:** ilan başına "CV ipuçları" (bu ilana göre neyi öne çek, hangi maddeyi ilanın diliyle yeniden yaz, ilanda olup CV'de olmayan) ve en iyi N ilana toplu bakan **CV incelemesi**. Uydurma tecrübe önermez.
- **Bildirim:** Telegram (isteğe bağlı): skor, özet, en güçlü artı/eksi, çalışma şekli. Dashboard'da masaüstü bildirimi.
- **Maliyet:** her `claude -p` çağrısının süresi ve CLI'nin bildirdiği maliyet tur başına kaydedilir; Sistem sekmesinde son turların süre / maliyet / yeni ilan grafiği ve toplam kullanım görünür.

Tasarım notu: [`docs/BUILD_SPEC_V3_COLLECTOR.md`](docs/BUILD_SPEC_V3_COLLECTOR.md). Lisans: MIT.

**Kimin için:** Türkiye'de BA / PO / PM / ürün analisti arayan biri için yazıldı. Rol sözlükleri ve kabul edilen
şehirler `searches.yaml` → `radar:` bloğundan değiştirilir (başlık kapısındaki genel "alakasız" listesi kodda);
skorlama prompt'u tamamen `profile/` dosyalarından beslenir.

**Gizlilik:** LinkedIn'e hiçbir kimlik gitmez (cookie yok, login yok). Claude'a giden şey CV'n + kriterlerin +
ilan metni; `claude -p` senin hesabınla çalışır. Repoya giren hiçbir dosyada kişisel veri yoktur; `profile/*.md`,
`searches.yaml`, `.env` ve `data/` gitignore'dadır.

## Kurulum

Gerekenler: Node ≥ 22.13, Claude Code CLI kurulu ve giriş yapılmış (`claude --version` çalışmalı).

```bash
git clone <repo> is-radar && cd is-radar
npm install
npm run init        # .env, searches.yaml, profile/cv.md, profile/criteria.md şablonlardan kopyalanır
```

Sonra üç dosyayı kendine göre doldur (hepsi gitignore'da, repoya girmez):

| Dosya | Ne |
|---|---|
| `profile/cv.md` | CV'n. Her skorlama isteğinde Claude'a gider; iletişim/kimlik bilgisi koyma. |
| `profile/criteria.md` | Kabul ettiğin şehirler, roller, kıdem, kırmızı çizgiler. Prompt'a olduğu gibi eklenir. |
| `profile/about.md` | İsteğe bağlı: sen kimsin, neyi seversin, neye hayır dersin. Doluysa 60 üstü ilanlarda artı/eksiler sana göre yazılır, ön yazı buradan beslenir. |
| `searches.yaml` | LinkedIn aramaları (anahtar kelime + lokasyon), tur modları, zamanlayıcı. Dashboard'dan da düzenlenir. |

`.env` isteğe bağlı: port, model seçimi, tur başına skor bütçesi, Telegram. Açıklamalar dosyanın içinde.

> Kabul edilen şehirler ve rol sözlükleri `searches.yaml` içindeki `radar:` bloğundan ayarlanır (yoksa yerleşik:
> Ankara/İzmir/Manisa/Aydın, BA/PO/PM). Kural motoru, LLM prompt'u ve dashboard aynı listeyi kullanır.

## Çalıştırma

```bash
npm run build       # dashboard -> public/  (dashboard'u her değiştirdiğinde tekrar)
npm run serve       # zamanlayıcı + http://localhost:4545
```

`serve` açıkken `searches.yaml`'daki aralıkla (varsayılan 180 dk, 07-23 arası) tur atar; dashboard'daki
**Tur başlat** ile elle tetiklenir. İlk tur *full* (30 gün), sonrakiler *incremental* (son turdan beri).

Tur = aramalar → yeni kartlar → ilan metinleri → ön eleme → `claude -p` ile skor → ikinci görüş → araştırma → Telegram.
**Kararlar = asıl doğru:** eşik üstü bir ilanı yoksay/reddet deyince tek tıkla sebep sorulur (rol, şehir/ofis,
maaş, şirket, kıdem, ilan dili…); detayda da değiştirilir. Kalibrasyon kartı "LLM beğendi, sen geçtin" ve
"LLM eledi, sen beğendin" sayılarını sebep kırılımıyla gösterir, tıklayınca o ilanlar açılır. Ayarlar → **Kriter
incelemesi** (`npm run criteria-review`) 10+ karardan `criteria.md` / `about.md` için somut değişiklik önerir.

**Kalibrasyon:** Sistem sekmesindeki kart kural motoru ile LLM'in ne kadar hemfikir olduğunu gösterir (matris,
hücreye tıklayınca o ilanlar açılır). 20+ skorlu ilan birikince kural puanı eşiklerini (reject/review/candidate)
LLM'e en çok uyan noktaya taşımayı önerir; "Uygula" `searches.yaml` → `radar.thresholds`'a yazar, ön elemeler
hemen yeniden hesaplanır. Ayarlar'da aynı blok form olarak da düzenlenir (şehirler, roller, eşikler).

Ayrıca **tazelik kontrolü:** shortlist/başvurdum/görüşme ve eşik üstü yeni ilanlar 3 günde bir yeniden çekilir;
"artık başvuru kabul etmiyor" ya da kaldırılmış (404) olanlar "kapandı" işaretlenir ve triage kuyruğundan düşer
(tur başına `LIVENESS_BUDGET_PER_RUN` istek). Detayda "İlan açık mı?" ile anında kontrol edilir.

Hız için üç şey yapılır: **arama rotasyonu** (artımlı turlarda üst üste boş dönen aramalar 2./3./4. turda bir
çalışır; `data`'daki `searchStats` ayarında izlenir), **öncelikli metin çekme** (tur bütçesi önce hedef rol
başlıklarına harcanır), **toplu skorlama** (`SCORE_BATCH`, varsayılan 3 ilan/çağrı; ölçüm: 3 ilan tek çağrıda
~70 sn, tek tek ~250 sn). LinkedIn misafir ucu `f_E`/`f_JT`/`sortBy` filtrelerini yok sayar, arama tarafında
kısayol yok.

**Ölçüm notu (2026-09-23):** aynı 13 ilgili ilanı 3'er kez skorlattık; tek okumada en yüksek − en düşük farkı
eski bütüncül prompt'ta ortalama 16,8, olgu + fit yönteminde 15,4 puan. Yani tek LLM okuması eşik kararını
çevirebilecek kadar oynak. İki okumanın birleştirilmesi bu farkı simülasyonda 15,6'dan 9,6'ya indiriyor; ikinci
okumanın sınır bandına harcanmasının sebebi bu (`TOP_MIN_SCORE`..`TOP_MAX_SCORE`, ayrıca fit'i yüksek olup bir
olgu yüzünden düşen ilanlar).

**Tekrar yayınlar:** aynı şirket + başlık + şehir 60 gün içinde yeni id ile gelirse eskisine bağlanır; metni
çekilmez, skorlanmaz, listede tek satır kalır. **Profil sürümü:** her skor CV/kriter/about.md hash'iyle saklanır;
profil değişince Sistem sekmesi eşiğe yakın eski skorları "Yeniden skorla" ile güncellemeyi önerir.

**Güvenlik:** API sadece 127.0.0.1'i dinler ve Host / Origin kontrol eder; tarayıcıda açık başka bir site tur
ya da skorlama tetikleyemez (DNS rebinding ve cross-site POST 403 alır).

Listede satırın üzerine gelince modelin özeti, ilk artı/eksiler ve kural motorunun gerekçesi çıkar; açılmamış
ilanlar kalın + nokta ile, son turda gelenler "yeni" etiketiyle ayrılır.

## Komutlar

```
npm run init                                   ilk kurulum dosyaları
npm run build                                  dashboard build (public/)
npm run dev                                    dashboard watch build
npm run serve                                  zamanlayıcı + web
npm run run      -- [--full|--incremental] [--max-searches N] [--pages N] [--details N] [--no-score] [--no-research] [--score-budget N]
npm run score    -- [--limit N] [--include-rejects] [--top]
npm run research -- [--min-score N] [--limit N]
npm run cv-review -- [--limit N] [--min-score N] en iyi N ilana göre CV incelemesi → data/cv-review.md (Ayarlar'da da var)
npm run import   -- <backup.json>              eski v2 extension yedeğini içe aktar
npm run reset    -- [--scores | --texts | --all]   (önce data/backups/ altına .db yedeği alır)
npm run doctor                                 claude cli teşhisi + örnek skorlama ham çıktısı
npm test                                       parser + ön eleme testleri
npm run typecheck                              node + dashboard tip kontrolü
npm run check                                  typecheck + test + build
```

## Yapı

```
src/                 Node 22 (--experimental-strip-types), tek paket
  index.ts           CLI
  config.ts          .env, searches.yaml, yollar
  run.ts             bir tur
  db.ts              SQLite (node:sqlite), jobs/runs/settings
  http.ts            nazik HTTP istemcisi (aralık, saatlik tavan, 429 geri çekilme)
  sources/           linkedin-guest.ts: arama + detay parser (cheerio)
  search-plan.ts     arama rotasyonu (verimsiz aramalar seyrek çalışır)
  pipeline/          prescreen → score (claude-cli, toplu) → research → cv (ipuçları, inceleme) → notify
  web/server.ts      REST + statik dashboard
  shared/            dashboard ile ortak: types, prescreen (kural motoru), prompt, jobs helpers
dashboard/           React dashboard (vite, saf CSS token'ları); build -> public/
profile/             cv.md, criteria.md, about.md (gitignore) + *.example.md
test/                parser fixture testleri, ön eleme testleri
data/                is-radar.db, samples/ (selector kırılınca ham HTML), backups/  (gitignore)
```

## Public kopya

Çalışma repo'sunun geçmişinde kişisel dosyalar olabilir; public repo bu yüzden geçmişsiz bir `public` dalından
beslenir. Eşitlemek için `scripts\publish.cmd` (Windows) ya da `scripts/publish.sh`: çalışma dalının ağacını
`public` dalına kopyalar, tek bir sync commit'i atar, `public` remote'una push eder. Gitignore'daki dosyalar hiç gitmez.

## Veri

`data/is-radar.db`. Yedek = dosyayı kopyalamak; `npm run reset` de her seferinde `data/backups/` altına kopya alır.
Selector kırılırsa ham HTML `data/samples/` altına düşer, tur devam eder, `npm test` fixture'larıyla düzeltilir.
