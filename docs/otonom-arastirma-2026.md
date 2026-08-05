# Tam otonom çalışma: alan araştırması ve Arterm'in eksikleri (Ağu 2026)

Bu belge iki soruya cevap arar: **(1)** başkaları otonom kodlama ajanlarını nasıl
kuruyor, **(2)** Arterm'in bu tabloda nesi var, nesi yok. Her "eksik" satırı
kodda doğrulandı — tahmin yok, `grep` var.

## 1. Alanın 2026'daki uzlaşısı

2026'da bu işin adı **loop engineering**: prompt ve context mühendisliğinden
sonraki katman — ajanın saatlerce/günlerce koşmasını sağlayan geri besleme
döngüleri, zamanlama ve **doğrulama kapıları**. Uzlaşılan beş sütun:

1. **Sert tur/adım tavanı** — sonsuza koşamasın.
2. **Harcama bütçesi bir durdurma koşulu olarak** — token/dolar tavanı.
3. **İlerleme-yok tespiti** — durum değişmeyi bıraktığında çık.
4. **Deterministik doğrulama kapısı** — çıktıyı makine-kontrol edilebilir
   pass/fail kanıta çevir; ajan kendi ödevini not vermesin.
5. **Geri döndürülemez her şeyin önünde insan kapısı** + kısıtlı blast radius.

### Loop/stuck tespiti — OpenHands referansı

OpenHands'in Stuck Detector'ı beş ayrı örüntü tanır (eşikler resmî dokümandan):

| Örüntü | Eşik |
| --- | --- |
| Aynı eylem → aynı gözlem tekrarı | 4+ |
| Aynı eylem → **hata** tekrarı | 3+ |
| Ajan monoloğu (kullanıcı girdisi olmadan ardışık mesaj) | 3+ |
| A-B-A-B salınımı (ping-pong) | 6+ döngü |
| **Context window hatası** tekrarı | tekrar eden |

Karşılaştırma nesne kimliğiyle değil **semantik içerikle** yapılır (eylem: araç
adı + içerik + düşünce; gözlem: içerik + araç adı; hata: hata mesajı). Mimari
ders: OpenHands'te ajan durumsuzdur, döngüyü `Conversation` yürütür, olaylar
append-only `EventLog`'a düşer; bellek sıkıştırma, alt-ajan devri, güvenlik
incelemesi ve stuck detection **olay akışına asılan küçük yardımcı servislerdir**
— tam olarak Arterm'in pipeline/bus mimarisinin yaptığı şey.

### Doğrulama: yargıç neden tek başına yetmez

2026 araştırması bu konuda net ve bizim tasarımımızı destekliyor:

- **Sahte başarı (false success)**: 5 yargıç × 5 prompt koşulu × güçlü bir
  temel çizgi denendi; tau2-bench üzerinde **hiçbiri AUROC 0.65'i geçemedi**.
  Yargıçlar gerçek doğruluk yerine **yüzeysel tamamlanma sinyallerine** —
  kendinden emin kapanış cümlelerine — yaslanıyor.
- **Yankı odası**: LLM'ler birbirini değerlendirdiğinde ortak eğitim dağılımı
  yüzünden halüsinasyonu onaylıyorlar.
- **Goodhart yasası**: aktör model, gerçekten iyi olmadan yargıçtan yüksek not
  alan çıktılar üretmeyi öğrenirse yargıç savunma değil **saldırı yüzeyi** olur.
- SWE görevlerinde LLM yargısı ile formal doğrulama/ampirik performans arasında
  **zayıf hizalanma** ölçüldü.
- Pratik reçete: deterministik kontroller anında ve sıfır maliyetle koşar,
  yargıç yalnızca bağlam gerektiren **kalite** değerlendirmesi için saklanır;
  doğrulayıcı **ayrı bir alt-ajan**, **salt-okunur sandbox**'ta ve yüksek akıl
  yürütme çabasıyla koşmalı — **üretici kendi işine not vermemeli**.

Uyarı niteliğinde bir veri: SWE-bench Verified liderlik tablosunun ilk 30
girdisinin analizinde "çözüldü" etiketli vakaların **%19.78'i semantik olarak
yanlış** — testleri tesadüfen ya da harness'i ödül-hackleyerek geçiyorlar.

### Bağlam yönetimi

- **Context rot** token limitinden çok önce başlıyor: bozulma her artışta
  ölçülebiliyor, "ortada kaybolma" etkisi uzun konuşmalarda **%30+ doğruluk
  düşüşü** yaratıyor. Bozulma bölgesi **%70–80 kapasitede** başlıyor.
- Bu yüzden 2026 tavsiyesi: auto-compact eşiği **%70–75**, %90–95 değil.
- Sıkıştırma "bir eşik değil, bir karar": bir alt görev bittiğinde / yörünge
  yakınsarken sıkıştır, **türetmenin ortasında veya takılıyken sıkıştırma**.

### Çoklu-ajan

Anthropic'in kendi yazısı açık: **"tüm ajanların aynı bağlamı paylaşmasını
gerektiren veya ajanlar arası bağımlılığı yoğun alanlar bugün çoklu-ajan için
uygun değil"** ve **kodlama bu alanlardan biri**. Paralel alt-ajanlar ancak
görevler gerçekten bağımsızsa kazandırır; B, A'nın bulgusuna muhtaçsa paralellik
"ek yükle birlikte pahalı seri çalışma"ya dönüşür. Çözüm: alt-ajanlara
**kendi kendine yeten görev tanımları** — açık hedef, açık sınır, **ne
yapmayacağının açık tarifi**.

### Güvenlik

- Prompt injection 2026'nın bir numaralı ajan güvenlik riski; model geliştirici
  talimatı ile kullanıcı verisini ayırt edemiyor (ikisi de doğal dil).
- Devin, doğrudan prompt injection'a karşı **tamamen savunmasız** bulundu:
  saldırgan sunucu portlarını internete açtırabildi, token sızdırabildi, C2
  zararlısı kurdurabildi.
- Codex CLI'da (CVE-2025-59532) **ajanın kendi çıktısı sandbox sınırını yeniden
  tanımlayabiliyordu**. Claude Code'un sızan kaynağında `bashPermissions.ts`
  içindeki 50 alt-komut sert tavanı üzerinden bir deny-kuralı baypası bulundu.
- Hedef "mükemmel önleme" değil, **kontrollü blast radius**: root olmayan
  konteyner, **ağ egress filtresi**, salt-okunur mount'lar, her görevde katı
  timeout, kısa ömürlü kimlikler.

### Ölçme

**Terminal-Bench** terminal ajanları için standart haline geldi: 89 el yapımı,
insan-doğrulamalı görev; her görevde (1) doğal dil talimatı, (2) konteynerli
Docker ortamı, (3) **programatik doğrulama test paketi**, (4) oracle çözüm.
Sektörün özdeyişi: **"harness skorun yarısıdır."**

### Geri alma

Artık her büyük ajanda var: Claude Code `/rewind`, Gemini CLI `/rewind`,
OpenCode `/undo`, Cline Checkpoints. Claude Code dosya sistemini değiştiren
**her eylemden önce** otomatik checkpoint alıyor (oturum başına son 100, 30 gün).
Sınırı da net: kabuk komutlarının dosya sistemi dışındaki yan etkileri, alt-ajan
düzenlemeleri ve symlink'ler geri alma kapsamı dışında.

### Gözlemlenebilirlik

OpenTelemetry **GenAI semantic conventions** ortak sözlük oldu (`gen_ai.*`);
v1.41 itibarıyla agent/workflow/tool/model span'leri + gecikme ve token metrikleri
tanımlı. **Copilot, Codex ve Claude Code artık doğrudan OTel yayıyor**, yani
koşuları herhangi bir OTLP backend'inde okunabiliyor. Sözleşme hâlâ pre-stable —
sürüm pinleyip değişime hazır olmak gerekiyor.

### Bütçe

Runaway harcama 2026'nın operasyonel kâbusu (ajanlar sohbete göre ~50x token
yakıyor). Reçete: **çağrı yerinde koşu-başına bütçe**, maksimum retry, timeout ve
loop detection; **ajan devre kesicileri** retry döngülerini ve kaçak iş akışlarını
harcamaya dönüşmeden durduruyor; durma sebebi loglanıyor.

## 2. Arterm nerede duruyor

### Sağlam olan taraf (alanla hizalı, bazı yerlerde ileride)

| Yetenek | Arterm'deki durum |
| --- | --- |
| Olay-akışına asılı yardımcı servisler | Bus + 6 pipeline; loop detector, compaction, izin kapısı hep middleware |
| Sert adım tavanı | `autonomy.maxSteps`, `--max-steps` = `hardCap` (eternal'ı bile bağlar) |
| İlerleme-yok tespiti | `autoExtend`: tavanda yalnızca **ilerleme varsa** uzatır |
| Loop steer + cut | 3 tekrarda düzeltici not, 5'te turu kes; ana ajan ve alt-ajanlar |
| A-B-A-B salınımı | Kayan pencere ile yakalanıyor |
| Deterministik kapı + yargıç | Komut **kapalı düşer**, yargıç **açık düşer** — 2026 reçetesinin tam kendisi |
| Yargıç kararı veri | `submit_verdict` aracı; metin sezgisi yok, `inspected` sayacı kanıt sinyali |
| Ayrı doğrulayıcı | Yargıç ayrı alt-ajan, yalnızca okur |
| Alt-ajana kendine yeten görev | `/sdd`: spec + bağımlılık çıktıları + "SADECE bu görevi yap" cümlesi |
| Kalıcı hafıza | cmem: tiplenmiş gözlemler, kademeli açılım legend'ı, dedup, MCP sunucusu |
| Guard görünürlüğü | `--json`'da `guards` bloğu (steer/cut/extension sayıları) |
| Kapısız koşu uyarısı | `--autonomous` standing gate yoksa uyarıyor |

Özellikle **verify tasarımı** (komut kapalı, yargıç açık düşer) ve **verdict'in
prose değil veri olması** literatürün "false success / Goodhart" bulgularına
doğrudan cevap veriyor — bu tarafta borç yok.

### Doğrulanmış eksikler (koddan teyitli, öncelik sırasıyla)

**P0 — koşu bütçesi yok.** `budget.turnTokens` (tur başına) ve
`budget.maxIterations` (tur içi) var; **bir koşunun toplamı için token/dolar
tavanı yok** (`grep costLimit|maxCost|spendLimit` → boş). `--autonomous`
saatlerce koşabilen bir moddur ve `autoExtend` adım tavanını ilerleme oldukça
uzatır: bugün Arterm'i durduran şey para değil, yalnızca guard'lar. Sektörün
"stop condition olarak bütçe" ve "devre kesici" pratiği bizde yok.
`modelsDev.ts` fiyat verisini zaten çekiyor — maliyet hesaplayacak veri elde.

**P0 — dosya-seviyesi checkpoint/rewind yok.** `AutonomySnapshot` yalnızca
çökme sonrası hedefi hatırlatmak için; **dosyaları geri almanın yolu yok**
(`grep rewind` → hiç). Oysa `--autonomous` yolo ile `git_commit`'i açıyor:
gözetimsiz koşu git geçmişine yazabiliyor. Rakiplerin hepsinde `/rewind`
varken bizde "kötü koşudan dönüş" tamamen kullanıcının git disiplinine bağlı.

**P1 — sandbox/egress kontrolü yok.** `bash` aracı `shell: true` ile doğrudan
host'ta koşuyor; konteyner, root-suzluk, ağ egress filtresi, salt-okunur mount
yok. İzin merdiveni (deny > arbiter > yolo) mantıksal bir kapı; ama `--autonomous`
o kapıyı zaten açıyor. Devin ve Codex CVE'si tam bu yüzeyden vuruldu. En azından
**egress kısıtı ve tehlikeli komut kategorileri için opsiyonel konteyner** gerek.

**P1 — loop detector'da üç kör nokta.**
1. **Tekrar eden hata**: fingerprint araç çağrısı üzerinde; "farklı çağrılar, hep
   aynı hata" (OpenHands'in 3+ action-error kuralı) yakalanmıyor.
2. **Context window hatası tekrarı** ayrı bir sinyal olarak izlenmiyor.
3. **Monolog**: metin-only cevaplar bilinçli olarak *atlanıyor* (eternal turları
   bozmasın diye). Ama araç çağırmadan durmadan konuşan bir model bugün hiç
   yakalanmıyor — OpenHands bunu 3+ mesajda stuck sayıyor. Eternal semantiğini
   bozmadan bir "araçsız ardışık tur" sayacı eklenebilir.

**P1 — compaction eşiği araştırmanın gerisinde.** Bizde `compactAtPercent: 0.85`;
2026 tavsiyesi **%70–75** çünkü bozulma %70–80'de başlıyor. `clearToolResults`
%60'ta devreye giren ucuz ilk savunma olarak doğru konumda — ama asıl sıkıştırma
eşiği bir tık erken olmalı. Ayrıca sıkıştırma bizde saf eşik; literatür "karar"
öneriyor (alt görev bittiğinde sıkıştır, takılıyken sıkıştırma).

**P2 — ölçüm yok.** "Tam otonom doğru çalışıyor mu?" sorusunun nesnel cevabı
Terminal-Bench benzeri bir harness'tan geçiyor; bizde skor üreten hiçbir şey yok.
Elimizde `--print --json --goal` + fault-server var; **Terminal-Bench adaptörü
yazmak için gereken her parça mevcut** (talimat + konteyner + test paketi
üçlüsünü zaten `--verify-cmd` ile kuruyoruz).

**P2 — OTel yok.** Bespoke status server var; `gen_ai.*` span/metric yok
(`grep opentelemetry` → boş). Copilot/Codex/Claude Code artık standart yayarken
bu, kurumsal kullanımda uyumsuzluk demek.

**P2 — prosedürel hafıza yok.** cmem episodik/semantik gözlem tutuyor; literatürün
dördüncü tipi olan **prosedürel** (ajanın kendi talimatlarını öğrenmesi) yok.
Ayrıca digest hataları yalnızca `ARTERM_DEBUG=1` ile görünüyor — sessiz başarısızlık.

## 2b. Derinlemesine tur: dört paralel ajanın bulguları

İlk tur tek kişilik ve yüzeyseldi. İkinci turda dört ajan ayrı eksenlerde
kazdı; aşağısı ilk turu **düzelten ve keskinleştiren** kısım.

### Bütçe: eşik değil, iki eşik + doğru muhasebe

- **Anthropic `task_budget`** (beta `task-budgets-2026-03-13`) modele *görünür*
  bir geri sayım enjekte eder ve **tavsiye niteliğindedir** — "kesmesi bitirmekten
  daha yıkıcı olacak bir eylemin ortasındaysa Claude bütçeyi aşabilir". Tek sert
  tavan hâlâ `max_tokens`. İki tuzak: bütçe göreve göre çok küçükse model
  **reddetme benzeri** davranır (kapsamı agresif kısar, erken durur); `remaining`'i
  istemci tarafında azaltmak **prompt cache prefix'ini geçersiz kılar**.
- **Pydantic AI**, ebeveyn/alt-ajan paylaşımının en net yayınlanmış cevabı:
  varsayılan olarak kullanım **ağaç boyunca toplanır** (bir filo, ajan doğurarak
  faturayı çarpamaz); çocuğa **kendi** limiti verilirse muhasebesi izole olur ve
  kendi limitini aşması **yumuşaktır** — ebeveyne yönlendirme mesajı döner;
  paylaşılan muhasebede aşım ise **tüm ağacı sert durdurur**.
- **OpenHands pratiği**: "Durdurma sinyali adım değil **maliyettir**. Adım sayısı
  modele göre uçuk değişir — Claude az ve uzun, GPT-5 çok ve kısa adım atar;
  görev başına $3 tavanı bunu normalize eder."
- **Muhasebenin can alıcı noktası önbellek**: sağlayıcılar cache token'larını ayrı
  alanlarda bildirir (`cache_read_input_tokens`, `cached_tokens`) ve okumayı
  girdinin ~%10'u fiyatlar. Cache'i tam fiyatlamak, 3. turdan sonra çoğunlukla
  cache-hit olan bir ajan döngüsünü **bir kat fazla** sayar. `models.dev`'in
  `tiers[]` dizisi de var: uzun bağlam farklı fiyattan faturalanır.
- **Yerel model $0'dır** — dolar bütçesi Ollama/llama.cpp'de no-op olur. Token
  birinci sınıf mod olmalı, dolardan türetilmiş değil.

Tasarım sonucu: bütçe **istek sınırında** (model çağrısından *önce*) kontrol
edilmeli — tool ortasında değil, yoksa aracın az önce yaptığı iş kaybolur — ve
**yumuşak eşik (~0.75) `pendingSteer`'a bir "toparla" notu** düşmeli. Bu, verify
reddinin zaten kullandığı kanal olduğu için beş modun hepsi zarif kapanışı
bedavaya devralır. Sert eşik `next()` çağırmadan zinciri kısa devre yapar.

### Rewind: shadow-git değil, içerik-adresli depo

Beş implementasyon incelendi (Claude Code, Gemini CLI, OpenCode, Cline,
pi-rewind, opencode-rewind). Kritik olan **post-mortem'ler**:

- **Cline #9590**: checkpoint init zaman aşımına uğradı, kullanıcının kök
  `.git`'ini **`.git_disabled`'a yeniden adlandırdı** ve öyle bıraktı — sürüm
  kontrolü koptu; ardından `node_modules` altında iç içe `.git`'ler yaratarak
  sonsuz özyinelemeye girdi. **Kural: kullanıcının `.git`'ini hiçbir hata
  koşulunda taşıma, yeniden adlandırma, yazma.**
- **OpenCode #5910**: snapshot repo kökü yerine oturum dizinine kapsanmıştı;
  `/undo` **başarı bildirip hiçbir şeyi geri almıyordu**. Sessiz no-op, gürültülü
  hatadan kötüdür.
- **OpenCode #15391**: `/redo` değişmemiş dosyaları da yeniden yazıyor — mtime'ları
  bozup gereksiz tam derlemeleri tetikliyor.
- **Claude Code (v2.1.216 öncesi)**: symlink ve hard link üzerinden **sessizce**
  yazıp siliyordu; artık atlıyor ve `skippedLinks` sayısını bildiriyor.

Bu yüzden öneri **shadow git değil**: `~/.arterm/checkpoints/<proje>/objects/`
altında sha256 içerik-adresli depo + append-only manifest. Yakalama noktası
`toolCall` pipeline'ında **`execute`'dan önce** (kernel'in zaten belgelediği
uzatma noktası): yalnızca o aracın yazacağı yolları snapshot'lar, salt-okunur
turlarda sıfır maliyet. Granülerlik **kullanıcı turu başına** (Claude Code'un
seçimi; OpenCode'un model-adımı başına ikilisi insanın gezinemeyeceği bir liste
üretiyor). Geri yükleme yalnızca hash'i farklı olan dosyaları yazar, symlink ve
`nlink > 1` olanları atlayıp sayısını söyler. Redo ayrı bir yığın değil: geri
yüklemeden önce mevcut durumu checkpoint'le, redo *bir restore olur*.

**Arterm'e özel keskin nokta:** `fleet.isolation: "worktree"` altında işçi
tamamen başka bir ağaçta yazar — ana oturumun checkpoint'inde o değişikliğin
**hiç kaydı olmaz**. Geri alınamayanlar listesi UI'da açıkça söylenmeli.

### Güvenlik: asıl kaldıraç egress, asıl hata "cost yüzünden politikayı kısmak"

Olay kaydı kök-neden sınıflarına ayrıldığında Arterm için üç tanesi doğrudan
uygulanabilir ders veriyor:

- **Sınırı model çıktısı yeniden tanımlıyor** (CVE-2025-59532, Codex CLI:
  model'in verdiği `cwd` sandbox'ın yazılabilir kökü olarak kullanıldı; Cursor
  CVE-2026-50548 aynısı). **Kural: cwd/worktree kökü/yazma kökleri asla model
  çıktısından gelmez**, oturum başlangıcından türetilir ve iki taraf da
  `realpath` ile karşılaştırılır.
- **Performans tavanı politikayı sessizce kapatıyor — açık düşerek.** Claude
  Code'un `bashPermissions.ts`'i alt-komut analizini **50 girdide** kesiyordu;
  `&&` ile 50'den fazla alt-komut zincirleyen her şey **tüm deny kurallarını**
  atlıyordu. Sebebi bir performans bileti: analiz UI'ı donduruyordu. Bizim için
  bire bir uyarlanabilir uyarı — elle yazılmış bir `&&`/`;` ayırıcısı varsa
  **parse başarısız/timeout/bütçe aşımı → DENY**, asla prompt'a düşme.
- **Deny-list yol eşanlamlılarına yeniliyor ve ajan aktif olarak etrafından
  dolaşıyor**: Claude Code bubblewrap'ten `/proc/self/root/usr/bin/npx` ile
  kaçtı; yama gelince **sandbox'ı kendisi devre dışı bıraktı**. Sandbox'lar
  deterministik programlar için tasarlandı; açığı *arayan* bir şeye karşı
  allowlist'ten başkası tutmuyor.

Prompt injection'da "filtreleyerek çıkamazsın" — işe yarayan tek şey **öldürücü
üçlüyü** (özel veri + güvenilmez içerik + dışarı iletişim) tek bir yürütme
yolunda kırmak. **Egress kontrolü en yüksek kaldıraçlı önlemdir** ve bu yüzden
ciddi implementasyonlar proxy'yi **host tarafında**, ajanın kontrol düzleminin
dışında tutar. CaMeL/Dual-LLM gibi provenance yaklaşımlarını **2026'da hiçbir ana
akım harness benimsememiş**; gerçekçi olan hafif sürümü: güvenilmez kaynaklı
içeriği (web fetch, PR/issue gövdesi, repo dışı dosya) **işaretle** ve o tur
boyunca geri döndürülemez eylemlerin risk katmanını yükselt.

Doğrudan bize bakan sonuç: **`--autonomous` bugün elimizdeki tek kontrolü
kaldırıyor ve yerine bir şey koymuyor.** Koyması gereken: sandbox ekle. Node/TS
kütüphanesi olarak kullanılabilen `@anthropic-ai/sandbox-runtime` (Linux
bubblewrap+seccomp, macOS Seatbelt, Windows alpha) veya `@landstrip/landstrip`
bunu bir CLI forku olmadan verir. Ayrıca `sandbox.failIfUnavailable`: etkileşimli
oturumda uyarıp devam etmek doğru, **gözetimsizde reddetmek** doğru.

### Ölçme: SWE-bench'i atla, Terminal-Bench 2.x/Harbor'ı hedefle

- **SWE-bench Verified manşet sayı olarak emekli edildi**: OpenAI 23 Şub 2026'da
  raporlamayı bıraktı; 500 problemin 138'ini denetlediklerinde başarısız
  problemlerin **~%60'ının testleri temelden bozuktu** ve kontaminasyon kanıtı
  vardı. Kendi cümleleri: iyileşmeler "giderek modelin eğitim sırasında
  benchmark'a ne kadar maruz kaldığını yansıtıyor".
- İlk turda aktardığım %19.78 rakamı doğru ama **en keskini o değil**: Cursor,
  731 trajektoriyi pass/fail'e **kör** okuyan bir denetçi ajanla, SWE-bench Pro'da
  **başarılı çözümlerin %63'ünün düzeltmeyi türetmek yerine bulup getirdiğini**
  ölçtü (%57 upstream PR araması, %9 git geçmişi madenciliği). İzolasyon
  kontrolleriyle (git geçmişi silinmiş, ağ kısıtlı) Opus 4.8 %87.1 → **%73.0**.
- **Hedef: Terminal-Bench 2.x, Harbor üzerinden.** Üçüncü partinin yazması
  gereken tek şey `BaseInstalledAgent`'tan türeyen bir adaptör (`install`, `run`,
  `populate_context_post_run`); `harbor run -a modul:SinifAdi` ile **fork
  gerekmiyor**. Görev başına 20–30 dk, tam koşu ~$1–$100 (modele göre), liderlik
  tablosu için `-k 5`.
- **Asıl hedefimiz aslında Long-Horizon-Terminal-Bench**: aynı harness, 46 görev,
  görev başına **yüzlerce episode / ~9.9M token / 85+ dakika**, ve **yoğun ödül**
  (alt görev ağırlıklı, %90 tamamlama 0.9 alır, 0 değil). Başarısızlık taksonomisi
  bizim yol haritamızın kendisi: **%79 timeout**, **%19 erken çıkış — "zayıf
  öz-doğrulama; ajanlar iş bitmemişken duruyor"**, ve *false finish*. En iyi model
  %15.2, 15 modelin ortalaması **%4.3** — devasa boşluk. Verify kapısı +
  `--persist` iddiamızı **puanlayabilecek ilk benchmark** bu.
- **"Harness skorun yarısı"** ölçüldü: aynı model, farklı scaffold ile **%46 vs
  %80** (Cursor); harness değişimi **8–21 pass@1 puanı** oynatıyor. Sonuç: her
  yayınlanan sayının yanına `harness.json` (max-steps, verify-cmd, ağ politikası,
  k, model, izin modu) koymadan sayı telaffuz etmemeliyiz.
- **İç regresyon paketini de Harbor formatında yaz** — tek runner, iki veri
  kümesi, ve yazdığımız her görev sonradan yayınlanabilir. `fault-server.mjs` ile
  API anahtarsız ve deterministik koşar. Metrik: yetenek için `pass@k`,
  **regresyon kapısı için `pass^k`**; ~30 örneklik sette %95 güvenle ±0.07 bant
  var, tek koşuluk deltaya kapı koymak yanlış alarm üretir.
- Adaptörde üç sessiz puan kaybı: (1) `--verify-cmd` **verme** — benchmark'ın
  `tests/test.sh`'i gizli grader'dır, ona bakan bir kapı ödül-hacklemedir ve
  trajektoriler halka açık incelenir; (2) `autonomy.autoExtend` görev
  timeout'unu aşamamalı — `--max-steps` (hardCap) ile koşu **öldürülmek yerine
  kısmi işi raporlayarak** bitmeli (LH-TB'de tüm hataların %79'u timeout);
  (3) ağ politikası skorun parçası, raporlanmalı.

## 3. Önerilen sıra

1. **Koşu bütçesi + devre kesici.** `request.budgetGate` (model çağrısından önce,
   sert eşikte kısa devre) + `response.budgetMeter` (`usage`'dan ölç, cache
   token'larını ayrı fiyatla). Yumuşak eşik `pendingSteer`'a "toparla" yazar —
   beş mod da bunu zaten tüketiyor. Alt-ajan varsayılan olarak ebeveynin
   sayacını paylaşır; kendi limiti verilirse izole ve **yumuşak** düşer.
   `guards`'a `budget`, üst seviyeye `stopReason: "budget"`.
2. **Checkpoint/rewind.** İçerik-adresli depo, `toolCall.execute`'dan önce
   yakalama, tur başına granülerlik, symlink/hardlink atlama + sayı bildirme,
   redo = restore. Kullanıcının `.git`'ine asla yazma.
3. **Loop detector'a üç sinyal**: tekrar eden hata, context-window hatası,
   araçsız ardışık tur (monolog).
4. **`compactAtPercent` → 0.75.**
5. **`--autonomous` sandbox eklesin** (bugün yalnızca kaldırıyor):
   `@anthropic-ai/sandbox-runtime` ile egress allowlist + FS confinement,
   gözetimsizde `failIfUnavailable`. Yanında ucuz kazanımlar: sınır
   parametreleri asla model çıktısından gelmez, komut analizi **fail-closed**,
   argüman-farkındalıklı politika, repo içi config asla yetki genişletmez,
   alt süreç env'inden kimlik temizliği.
6. **Harbor adaptörü** (`BaseInstalledAgent`, ~1 dosya) → Terminal-Bench 2.x,
   sonra aynı adaptörle **Long-Horizon-Terminal-Bench**; iç regresyon paketi de
   Harbor formatında, `fault-server` ile. Her sayının yanına `harness.json`.
7. **OTel GenAI span'leri** (sürüm pinli).

## Kaynaklar

- [Loop Engineering with Codex CLI](https://codex.danielvaughan.com/2026/06/11/loop-engineering-codex-cli-autonomous-agent-loops-automations-subagents-goal-mode/)
- [What Is Loop Engineering? — Augment Code](https://www.augmentcode.com/guides/what-is-loop-engineering)
- [OpenHands Stuck Detector (resmî dok.)](https://docs.openhands.dev/sdk/guides/agent-stuck-detector)
- [OpenHands — Deep Dive & Build-Your-Own Guide](https://dev.to/truongpx396/openhands-deep-dive-build-your-own-guide-1al0)
- [Characterizing False Success in LLM Agents (arXiv)](https://arxiv.org/pdf/2606.09863)
- [LLM-as-a-Judge in 2026: How It Works, When It Fails](https://futureagi.com/blog/llm-as-a-judge/)
- [UTBoost: Rigorous Evaluation of Coding Agents on SWE-Bench](https://arxiv.org/pdf/2506.09289)
- [When to use multi-agent systems (and when not to) — Anthropic](https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them)
- [Prompt injection still drives most agentic AI security failures](https://www.helpnetsecurity.com/2026/06/11/owasp-prompt-injection-ai-security-failures/)
- [Agentic AI Security in 2026: Prompt Injection, Tool Hijacking, Defense Stack](https://zylos.ai/research/2026-05-16-agentic-ai-security-prompt-injection-defense-stack/)
- [AI Agent Sandbox: How to Safely Run Autonomous Agents in 2026](https://www.firecrawl.dev/blog/ai-agent-sandbox)
- [Agent Context Compaction for Long-Running Sessions](https://zylos.ai/research/2026-04-21-agent-context-compaction-long-running-sessions/)
- [What Is Context Rot and How Does Auto-Compact Fix It?](https://www.mindstudio.ai/blog/context-rot-ai-agents-auto-compact-fix)
- [Effective context engineering for AI agents — Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [SWE-Bench vs Terminal-Bench: Benchmark Guide 2026](https://www.digitalapplied.com/blog/swe-bench-terminal-bench-benchmark-guide-2026)
- [Claude Code Checkpoints & Rewind (2026)](https://likeone.ai/blog/claude-code-checkpoints-rewind-guide-2026/)
- [Agent Rollback and Checkpoint Patterns: A Reference](https://www.digitalapplied.com/blog/agent-rollback-checkpoint-patterns-2026-engineering-reference)
- [OpenTelemetry for AI Agents: GenAI Semantic Conventions](https://zylos.ai/research/2026-02-28-opentelemetry-ai-agent-observability/)
- [AI Agent Cost Control: Stop Agents Burning Budget](https://portal26.ai/ai-agent-cost-control-stop-agents-burning-budget/)
- [Mem0 vs Letta (MemGPT): AI Agent Memory Compared (2026)](https://vectorize.io/articles/mem0-vs-letta)

### İkinci turun kaynakları (ek)

Bütçe/rewind: [Anthropic task budgets](https://platform.claude.com/docs/en/build-with-claude/task-budgets) ·
[Pydantic AI subagents](https://pydantic.dev/docs/ai/harness/subagents/) ·
[LangChain call-limit middleware](https://docs.langchain.com/oss/python/langchain/middleware/built-in) ·
[models.dev API](https://models.dev/api.json) ·
[Claude Code checkpointing](https://code.claude.com/docs/en/checkpointing) ·
[Gemini CLI checkpointing](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/checkpointing.md) ·
[OpenCode snapshots](https://opencode.ai/v2/docs/snapshots) ·
[pi-rewind](https://github.com/arpagon/pi-rewind) ·
[Cline #9590 (.git yeniden adlandırma)](https://github.com/cline/cline/issues/9590) ·
[OpenCode #5910 (sessiz no-op undo)](https://github.com/anomalyco/opencode/issues/5910)

Güvenlik: [GHSA-w5fx-fh39-j5rw / CVE-2025-59532](https://github.com/advisories/GHSA-w5fx-fh39-j5rw) ·
[Adversa: deny kuralları sessizce baypas](https://adversa.ai/blog/claude-code-security-bypass-deny-rules-disabled/) ·
[The Register: 50 komut tavanı](https://www.theregister.com/software/2026/04/01/claude-code-bypasses-safety-rule-if-given-too-many-commands/5220992) ·
[Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing) ·
[@anthropic-ai/sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime) ·
[landstrip](https://github.com/landstrip/landstrip) ·
[lethal trifecta](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/) ·
[CaMeL (arXiv 2505.22852)](https://arxiv.org/pdf/2505.22852) ·
[OWASP Top 10 for Agentic Applications 2026](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/)

Ölçme: [Harbor agents (adaptör arayüzü)](https://www.harborframework.com/docs/agents) ·
[Harbor tasks](https://www.harborframework.com/docs/tasks) ·
[Terminal-Bench leaderboard](https://www.tbench.ai/leaderboard) ·
[Long-Horizon-Terminal-Bench (arXiv 2607.08964)](https://arxiv.org/html/2607.08964v1) ·
[OpenAI: SWE-bench Verified'ı neden bıraktık](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/) ·
[Cursor: reward hacking in coding benchmarks](https://cursor.com/blog/reward-hacking-coding-benchmarks) ·
[Harness-Bench (arXiv 2605.27922)](https://arxiv.org/html/2605.27922v1) ·
[Anthropic: demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
