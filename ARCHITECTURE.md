# Arterm (Rust) — mimari

Bu ağaç jcode 0.75.0'ın fork'u. Katman modeli oradan geliyor; bu belge
**neden** öyle olduğunu ve fork'un upstream'den nerede bilerek ayrıldığını
kaydeder. "Ne" kısmı `Cargo.toml`'daki 83 crate.

## Temel kural

> Yüksek değişim hızlı orkestrasyon aşağıdaki kararlı katmanlara bağlanır.
> Kararlı katmanlar asla yukarı bağlanmaz.

Hem mimari hem derleme kuralı. Upstream'de ölçülmüş: kök davranış dosyasına
dokunmak ~6 sn, yüksek fan-out'lu bir sözleşme crate'ine dokunmak ~65 sn
yeniden derleme. Sözleşmeler nadiren değişmeli, bu yüzden içlerinde davranış
olmamalı.

## Katmanlar

```
arterm (bin + cli dispatch)
 └─ arterm-tui                 sunum
     └─ arterm-app-core        ajan döngüsü, tool'lar, server
         └─ arterm-base        provider, config, session, auth, memory
             ├─ L1 sözleşmeler provider-core, tool-core, protocol,
             │                 agent-runtime, storage, command-risk
             └─ L0 tipler      message-types, session-types, config-types,
                               tool-types
```

Yasak yönler: sözleşme crate'i çalışma zamanına bağlanamaz; provider crate'i
TUI'ye veya server'a bağlanamaz; TUI, protokol yeterliyken somut server iç
yapısına bağlanamaz.

Provider katmanı dört kademeli ve bölünme estetik değil **derleme argümanı**:
`provider-core` (sözleşme) / `provider-<ad>` (saf tel tipleri — reqwest ve
tokio *yok*) / `provider-<ad>-runtime` (HTTP, kimlik, retry) / `base` içindeki
kompozisyon. Saf crate `is_oauth` gibi şeyleri **parametre olarak** alır,
config okumaz; bu disiplin korunmazsa crate sayısı artar, fayda gelmez.

## Fork'un upstream'den ayrıldığı yer: güvenlik

Bu bölüm belgenin en önemli kısmı. Ölçülmüş, varsayılmamış: upstream ağacında
bubblewrap/seccomp/landlock araması yalnızca alakasız isabetler veriyor.

| Konu | Upstream (jcode) | Arterm TS | Bu fork'un hedefi |
|---|---|---|---|
| Tool başına izin sorusu | **yok** | tam merdiven (`allow/deny/prompt`) | TS |
| Sandbox (dosya/ağ sınırı) | **yok** | bubblewrap + egress allowlist | TS |
| Ortam değişkeni temizliği | **yok** — `bash` ve hook'lar tüm ortamı miras alırdı | `scrubEnv`, ad tabanlı | **portlandı** |
| Anahtar dosyalarının okunması | sıradan bir komut | `denyRead` + arbiter `critical` | TS |
| `webfetch` SSRF koruması | **yok** (yalnızca şema kontrolü) | var | TS |
| Komut risk analizi | **`arterm-command-risk`** — hasar yarıçapına göre | regex deny-list | **upstream** |

Upstream'in tek daima-açık kapısı `bash`'in yıkıcı-komut kapısı, ve o
korunmalı: komutu **adına göre değil hasar yarıçapına göre** sınıflandırıyor
(bir `rm -rf` listesi `find -delete`, `shred`, `truncate`, `dd`, `>dosya`
biçimlerini kaçırır), sarmalayıcıları (`sudo`, `env`, `xargs`, `timeout`)
çözüyor, `sh -c "..."` içeriğini özyinelemeli yeniden değerlendiriyor, ve
yolları normalize ederek `rm -rf ~/../..` yürüyüşünü kapatıyor.

İkinci aşaması da korunmalı: `Confirm` seviyesi ikinci bir model değil,
**cevabı denetlenebilir bir soru**. "Kullanıcının istediği hangi şey bu silmeyi
gerektiriyor? Bu yolu kullanıcı mı adlandırdı, siz mi çıkardınız?" —
tekrarlanarak geçilemez, çünkü belirli bir mesaj hakkında sınanabilir bir iddia
istiyor. Bir LLM yargıcı bunu yapamaz: pahalı, her sınır durumuna gecikme
ekler, ve komutu üreten muhakemenin aynısıyla ikna edilebilir.

Eklenecek `Tool` yeteneklerinin upstream trait'inde karşılığı yok
(`permission`, `category`, `concurrent`, `preview`) — çünkü orada sorulacak bir
soru yok. Risk komutun *argümanlarından* hesaplanıyor, tool'un bir özelliği
değil.

### Rebrand'in yarattığı sınıf: adı değişen, alıcısı değişmeyen uçlar

Bunlar fork'a özgü ve tek tek bulunmaları gerekti. Rebrand her `jcode.dev`
adresini `arterm.sh`'ye çevirdi; **veriyi kimin aldığını değiştirmedi.** Ortaya
çıkan şey, bizim işletmediğimiz bir alan adına giden ve varsayılan olarak açık
kanallar oldu. Üçü bulundu, üçü de kapatıldı:

| Uç | Neydi | Ne oldu |
|---|---|---|
| `telemetry.arterm.sh/v1/event` | varsayılan **açık** | `ARTERM_TELEMETRY=1` ile opt-in (`6b62ba8`) |
| `github.com/1jehuang/arterm` | var olmayan depo üzerinden self-update | varsayılan artık `Arclude/Arterm-CLI` (kendi release'lerimiz); `ARTERM_UPDATE_REPO` ezer, boş değer kapatır |
| `api.arterm.sh/v1/discovery` | varsayılan **açık** | `[sponsors] enabled` ile opt-in |

Discovery üçünün en ciddisiydi ve en geç fark edileni. Diğer ikisi sayaç ve
sürüm bilgisi taşıyor; bu, `discover_tools` üzerinden **modelin kendi yazdığı
`query` ve `reason` alanlarını** taşıyor — yani kullanıcının o an ne inşa
ettiğinin tarifini. Upstream'in `discover_secrets.rs` taraması gerçek bir
koruma ama bu deliği kapatmıyor: JWT, e-posta, kart numarası yakalar; "X
firmasının ödeme entegrasyonunu yazıyorum" hiçbir desene göre sır değildir ve
sızan tam olarak odur.

İki mekanizma daha kaldırıldı, ikisi de aynı sebeple:

- **`repair_frozen_sponsors_optout`** kullanıcının config dosyasındaki
  `enabled = false` değerini bellekte `true`'ya çeviriyordu. Upstream'in
  gerekçesi savunulabilirdi (eski bir kayıt tüm struct'ı serileştirip opt-in
  varsayılanını dosyaya dondurmuştu, ve bu "en büyük discovery engeli" idi).
  Fork'ta ters yöne çalışıyor. Ters çevirmek yerine **silindi**: bir opt-out,
  ancak yüklemeden sağ çıkarsa bir denetimdir. Simetrik durum —
  upstream'den miras `enabled = true` — kasten onarılmıyor, çünkü kimsenin
  yazmadığı bir `true` ile kasten yazılmış olanı ayırt edemeyiz; onun yerine
  `discovery_endpoint_note` açılışta bunu **söylüyor**. TS tarafındaki
  `contextWindowNote` kuralı: düzeltme, bildir.
- **Endpoint sabiti tek yazıma indirildi** (`DEFAULT_DISCOVERY_ENDPOINT`).
  Aynı dize dört yerde duruyordu ve okuyucuları eşleşmeye zıt anlamlar
  yüklüyor (biri varsayılanı kurar, biri kalıcılığı kapatır, biri uyarır).
  Kayan bir ikinci yazım gürültülü biçimde patlamaz — sadece eşleşmeyi
  bırakır, ve o okuyucuların hepsi sessizce tersini yapar.

### Kimlik bilgileri: bir komuta NE VERİLİYOR

`arterm_base::credentials`, TS'deki `core/src/credentials.ts`'in portu. Sandbox
(henüz yok) bir komutun nereye ulaşabileceğini söyler; bu, komutun eline ne
verildiğini. Sızıntı tek komut boyu: `env` yazar, ve o an anahtarlar
transkriptte — bir sonraki turda sağlayıcıya gider, oturum dosyasına yazılır,
her sonraki sıkıştırmaya katlanır. Modelin bunu istemesi de gerekmez; `npm
install` paket betiklerini aynı miras alınan ortamla çalıştırır.

Bağlandığı üç kapı: `tool/bash.rs` (üç spawn noktası, `build_shell_command` ve
detached sarmalayıcı), `hooks.rs`, ve `mcp/client.rs`.

Taşıyıcı üç özellik:

- **`env_clear()` önce gelir, yoksa hiçbir şey yapılmamış olur.** Çocuk ebeveynin
  ortamını miras alır, `envs()` yalnızca EKLER — yani temizlenmiş haritayı tek
  başına vermek, alıkonan isimleri yine de göndermek demektir. Ölçüldü:
  `env_clear` mutasyonla kaldırıldığında canary `sk-ant-…` alt sürece ulaşıyor
  ve seam testi düşüyor. TS tarafının `extendEnv: false` dersinin aynısı.
- **İsimlere bakar, değerlere değil.** "Bu bir token'a benziyor" tahmini eninde
  sonunda bir `PATH` girdisini yer, ve araç zincirini bozan denetim kapatılır.
  `SSH_AUTH_SOCK` ve `XDG_SESSION_*` kasten eşleşmez — bu özelliği batıracak
  yanlış pozitifler onlardır.
- **Bağlanmamışken bile varsayılan kapalı.** `scrub_env(base, None)` temizler.
  Bu plumbing'i hiç okumamış bir çağıran (bir hook, bir test) anahtarları hâlâ
  veren tek yol olmamalı.

MCP tarafında bir açık kapandı: oradaki yerel liste `_API_KEY` / `_ACCESS_TOKEN`
/ `_AUTH_TOKEN` son ekleri artı beş sabit isimdi ve **`ARTERM_SECRET` hiçbirine
uymuyordu** — yani keystore'u açan değişken, yapılandırılmış her MCP sunucusuna
veriliyordu. `GITHUB_TOKEN` ve `*_PASSWORD` de öyle. Artık tek kural, tek yerde:
aynı soruyu yanıtlayan iki liste birbirinden kayar, ve kayma sessizdir — dar
olan sadece eşleşmeyi bırakır.

`withheld_note` başarısız komuta ne alamadığını söyler, ve iki koşula bağlıdır:
komut BAŞARISIZ olmalı, ve kanıt (komut metni + çıktı) ismi gerçekten anmalı.
Koşulsuz olsaydı, ortamında anahtar bulunan her oturumda başarısız olan her test
koşusunun altına bir kimlik satırı eklerdi — modeli, o hatayla hiç ilgisi olmayan
bir nedene yönlendirerek.

**Daha fazlası olduğunu varsayın.** Denetlenmemiş kalanlar: `arterm.sh/account`
(abonelik/cihaz akışı), `api.arterm.sh/v1` (`subscription_api`), ve
`{sponsors.endpoint}/usage` (bağlanan MCP sunucularının kaba kullanım sayacı —
discovery kapalıyken zaten sessiz).

## Upstream'den korunacak, TS'de olmayanlar

- **Akış hızı denetimi** (`StreamBuffer`): gelme ile gösterme ayrılır.
  Sağlayıcılar farklı ritimlerde yazar (OpenAI çok sayıda küçük parça,
  Anthropic 80-100 ms'de bir 20-40 karakter — gözle görülür merdivenlenme).
- **`biased` select, girdi ilk sırada.** Rastgele seçimle, akış sırasında
  sunucu olayları neredeyse her zaman hazırdır ve tuş vuruşlarını geride
  bırakır.
- **İptal-güvenli soket okuma**: kalıcı arabellek + tarama imleci. `select!`
  dalında yarım okunan baytları kaybetmek protokolü bozar; taramaya sıfırdan
  başlamak çerçevelemeyi karesel yapar.
- **Yeniden çizim merdiveni**: odaksız+boşta 5 sn, statik metin 250 ms, akış
  sırasında tam hız. Ölçülmüş: duran bir ekran saniyede 63 tam çizim
  yapıyordu, 7680 hücrenin sıfırı değişerek.
- **Önek yeniden kullanan transkript hazırlığı** (`MessageBoundary`): bir mesaj
  eklemek kuyruk kadar maliyetli olmalı, transkript kadar değil.
- **Retry'de havuzlanmamış taze bağlantı**: TLS `BadRecordMac` üreten ağ yolu
  havuzdaki *diğer* boşta bağlantıları da zehirlemiş olabilir.
- **Kısmi çıktı geri alma** (`RetryRollback`): akış yeniden oynatılırken
  tüketici o ana dek biriktirdiğini atmalı, yoksa metin ikilenir.
- **Sinyaller ajan mutex'inin dışında.** Yoksa tool çalışırken iptal imkânsız,
  çünkü mutex'i tool tutuyor.

## Upstream'in kendi kabul ettiği borç

Bunlar fork'ta duruyor ve düzeltilmesi gereken yerler:

- `App` ~800 alanlı tanrı nesnesi, `TuiState` 140 metotlu trait. Upstream'in
  kendi analizi açık: önce **durum** parçalanmalı, trait değil — yalnızca
  trait'i bölmek tanrı nesnesini tanım gereği yerinde bırakır.
- `handle_client` 26 konumsal parametre (`handle_resume_session`: 32).
- **İstemci başına sınırsız, politikasız olay kuyruğu.** Yavaş bir istemci
  kuyruğu sınırsız büyütür. Sınırlı kanal + `TextDelta` için açık
  birleştir-ya-da-at kuralı gerekiyor.
- Bağlantının amacı bilinmeden **her bağlantıda tam `Agent` kurmak**.
- `webfetch`'te SSRF koruması yok.

## Durum ve sıradaki iş

Fork Arterm adıyla temiz derleniyor (`cargo check --workspace`, 0 hata).

Entegre edilecekler, TS envanterindeki büyüklükleriyle:

| Alt sistem | TS satır | Bağlanma noktası |
|---|---|---|
| İzin merdiveni + arbiter | 1.482 | `Registry::execute`, oturum politikası filtresinin yanına |
| Sandbox + kimlik temizliği | 932 | `tool/bash.rs` spawn yolu, `hooks.rs` spawn yolu |
| Verify gate | 1.123 | tamamlanma iddiası noktaları |
| Chronicle | 1.070 | tool yürütme dikişi |
| Autonomy / goal modları | 2.769 | yeni alt sistem |
| Headless `--print --json` | 560 | CLI dispatch |

Ölçü: TS envanterinde "asgari kullanılabilir ajan" 25.118 satır,
güvenlik/denetlenebilirlik +5.490, ileri alt sistemler +15.462.
