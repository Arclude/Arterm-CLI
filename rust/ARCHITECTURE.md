# Arterm Rust — hedef mimari

jcode'un (`/home/toygar/Belgeler/jcode`) katman modeli örnek alınmıştır. Bu
belge **neden** öyle olduğunu anlatır; "ne" kısmı `Cargo.toml`'daki crate
listesidir.

## Temel kural

> Yüksek değişim hızlı orkestrasyon aşağıdaki kararlı katmanlara bağlanır.
> Kararlı katmanlar asla yukarı bağlanmaz.

Bu hem mimari hem derleme süresi kuralıdır. jcode'da ölçülmüş: kök davranış
dosyasına dokunmak ~6 sn, yüksek fan-out'lu bir sözleşme crate'ine dokunmak
~65 sn yeniden derleme. Sözleşmeler nadiren değişmeli, bu yüzden içlerinde
davranış olmamalı.

## Katmanlar

```
arterm (bin)                       ince kompozisyon kökü: argümanlar, dispatch
 ├─ arterm-server                  daemon: soket, istemci yaşam döngüsü
 └─ arterm-tui                     sunum: istemci
     └─ arterm-app-core            ajan döngüsü, tool orkestrasyonu
         └─ arterm-base            provider kompozisyonu, config, session, auth
             ├─ L1 sözleşmeler     tool-core, provider-core, protocol,
             │                     agent-runtime, storage
             └─ L0 tipler          message-types, tool-types, session-types,
                                   config-types
```

Yasak yönler:

- Sözleşme crate'i çalışma zamanı crate'ine bağlanamaz.
- Provider crate'i TUI'ye veya server'a bağlanamaz.
- TUI, protokol yeterliyken somut server iç yapısına bağlanamaz.
- `arterm-core` her DTO'nun çöplüğü olamaz — bir küme büyüyünce kendi
  crate'ine ayrılır.

## Neden ajan döngüsü TUI'de olamaz

Şu an `arterm-tui/src/agent.rs`. Üç sonucu var:

1. Ajan başsız çalıştırılamaz (`--print`, benchmark, script).
2. Daemon ajanı barındıramaz — server'ın TUI'ye bağlanması gerekirdi.
3. TUI'deki her düzenleme ajan döngüsünü yeniden derler.

`arterm-app-core` bu yüzden var.

## Mesaj modelinin şekli

`Role` yalnızca `User` ve `Assistant`. `System` yok — sistem istemi
sağlayıcı çağrısının ayrı bir parametresi. `Tool` yok — bir tool'un sonucu,
`tool_use_id` ile eşleşen bir `ContentBlock::ToolResult` olarak **User**
mesajının içinde taşınır.

Düz `{role, content: String}` bu eşleşmeyi ifade edemez. Sonucu: paralel tool
çağrılarında hangi sonucun hangi çağrıya ait olduğu kaybolur.

### Üç ayrı reasoning bloğu

Aynı şey değiller; farkları **sonraki turda geri gönderilip
gönderilmedikleri**:

| Blok | Sonraki turda | Neden |
|---|---|---|
| `ReasoningTrace` | gönderilmez | Transkript için tutulur, token maliyeti yok |
| `Reasoning` | gönderilir | Kendi reasoning'ini geri isteyen backend'ler |
| `AnthropicThinking` | imzasıyla gönderilir | Anthropic tool'larla birlikte imza şart koşar |

Tek bir tipte toplamak, üçünden ikisini bozar.

## Akış olayları neden 4 değil ~15

Bir tool çağrısı tek parça gelmez. Önce `ToolUseStart` (isim), sonra
`ToolInputDelta` parçaları — ki **yalnızca birleştirildiklerinde** JSON olarak
geçerlidirler — sonra `ToolUseEnd`. Tek bir chunk'ta hem isim hem tam argüman
bekleyen kod, standart bir uçta **hiç** tool çağrısı üretmez.

Her üç olay da çağrının `id`'sini taşır. jcode'un `StreamEvent`'inde taşımıyor;
orada sorun çıkmıyor çünkü sağlayıcıları çağrıları sırayla gönderiyor. OpenAI
uyumlu uçlarda paralel çağrı normal durumdur: iki çağrı da kapanmadan açılır,
ve kimliksiz bir `End`'i en son `Start`'la eşleştiren tüketici bir tool'a
diğerinin argümanlarını verir. Bu bilgi tel üzerinde yoksa sonradan
onarılamaz.

## Hata sınıflandırması bir politikadır

Durum kodu tek başına yalan söyler. Anthropic tükenmiş bir kullanım bütçesine
**400** yanıtı verir — "isteğin bozuk" anlamına gelen, yeniden denenmeyen ve
yedek zincirini hiç başlatmayan bir sınıf. Bu yüzden gövde, koddan önce
okunur (`classify`).

Aynı nedenle `Retry-After` sınırsız uygulanmaz: bir saatlik bekleme isteğin
*içinde* uyunursa yedek zinciri bunu göremez ve kullanıcı hiç bitmeyen bir tur
görür. Tavan aşılınca cevap "vazgeç"tir — tur hâlâ canlıyken zincir devreye
girebilsin diye.

## jcode'un tasarımı nerede alınmaz

Bu bölüm belgenin en önemli kısmı, çünkü "tasarım jcode gibi olsun" kuralının
körü körüne uygulanmasının **güvenliği geriye götürdüğü** yerleri sayar.
Ölçülmüş, varsayılmamış: jcode ağacında bubblewrap/seccomp/landlock araması
yalnızca alakasız isabetler veriyor.

| Konu | jcode | Arterm TS | Rust portu |
|---|---|---|---|
| Tool başına izin sorusu | **yok** | tam merdiven (`allow/deny/prompt`) | TS |
| Sandbox (dosya/ağ sınırı) | **yok** | bubblewrap + egress allowlist | TS |
| Ortam değişkeni temizliği | **yok** — `bash` ve hook'lar tüm ortamı miras alır | `scrubEnv`, ad tabanlı | TS |
| Anahtar dosyalarının okunması | `cat ~/.jcode/*` sıradan bir komut | `denyRead` + arbiter `critical` | TS |
| `webfetch` SSRF koruması | **yok** (yalnızca şema kontrolü) | var | TS |
| Komut risk analizi | **`jcode-command-risk`** — hasar yarıçapına göre | regex deny-list | **jcode** |

jcode'un tek daima-açık kapısı `bash`'in yıkıcı-komut kapısı. Onun *yaklaşımı*
alınmalı, çünkü Arterm'in regex listesinden bir yönden üstün: komutu **adına
göre değil hasar yarıçapına göre** sınıflandırıyor (`rm -rf` listesi
`find -delete`, `shred`, `truncate`, `dd`, `>dosya` biçimlerini kaçırır),
sarmalayıcıları (`sudo`, `env`, `xargs`, `timeout`) çözüyor, `sh -c "..."`
içeriğini özyinelemeli yeniden değerlendiriyor, ve yolları sembolik-bağ
duyarsız biçimde normalize ederek `rm -rf ~/../..` yürüyüşünü kapatıyor.

Kapının ikinci aşaması da alınmaya değer: `Confirm` seviyesi ikinci bir model
değil, **cevabı denetlenebilir bir soru**. "Kullanıcının istediği hangi şey bu
silmeyi gerektiriyor? Bu yolu kullanıcı mı adlandırdı, siz mi çıkardınız?" —
tekrarlanarak geçilemez, çünkü belirli bir mesaj hakkında sınanabilir bir
iddia istiyor.

Bu yüzden `arterm-tool-core`'daki `Tool` trait'i jcode'unkinden **farklı**:
`permission()`, `category()`, `concurrent()` ve `preview()` taşıyor. jcode'da
bunların hiçbiri yok, çünkü orada sorulacak bir soru yok.

## jcode'dan alınacaklar, TS'de olmayanlar

- **Akış hızı denetimi** (`StreamBuffer`): gelme ile gösterme ayrılır.
  Sağlayıcılar farklı ritimlerde yazar (OpenAI çok sayıda küçük parça,
  Anthropic 80-100 ms'de bir 20-40 karakter — gözle görülür merdivenlenme).
  Oransal denetleyici, tavan hızı kendi ayrı bütçesinde tutulur ve boşta geçen
  süre biriktirilemez.
- **`biased` select, girdi ilk sırada.** Rastgele seçimle, akış sırasında
  sunucu olayları neredeyse her zaman hazırdır ve tuş vuruşlarını sürekli
  geride bırakır.
- **İptal-güvenli soket okuma**: kalıcı arabellek + tarama imleci. `select!`
  dalında yarım okunan baytları kaybetmek protokolü bozar; taramaya sıfırdan
  başlamak çerçevelemeyi karesel yapar.
- **Yeniden çizim merdiveni**: odaksız+boşta 5 sn, derin boşta 5 sn, statik
  metin 250 ms, akış sırasında tam hız. Ölçülmüş: `/resume` seçicisinde duran
  bir ekran saniyede **63 tam çizim** yapıyordu, 7680 hücrenin sıfırı değişerek.
- **Önek yeniden kullanan transkript hazırlığı** (`MessageBoundary`): bir mesaj
  eklemek kuyruk kadar maliyetli olmalı, transkript kadar değil.
- **Renk ikamesi çerçeve arabelleğinde**: ~250 dağınık renk sabiti, çağrı
  yerlerine dokunmadan yapılandırılabilir hale gelir.
- **Retry'de havuzlanmamış taze bağlantı**: TLS `BadRecordMac` üreten ağ yolu
  havuzdaki *diğer* boşta bağlantıları da zehirlemiş olabilir.
- **Kısmi çıktı geri alma** (`RetryRollback`): akış yeniden oynatılırken
  tüketici o ana dek biriktirdiğini atmalı, yoksa metin ikilenir.

## jcode'dan alınmayacak kalıplar

Raporun kendi "anti-pattern" listesi:

- `handle_client`'ın **26 konumsal parametresi** (`handle_resume_session`: 32).
- **İstemci başına sınırsız olay kuyruğu, politikasız.** Yavaş bir istemci
  kuyruğu sınırsız büyütür. Sınırlı kanal + `TextDelta` için açık birleştir-ya-da-at
  kuralı baştan konursa sonradan eklemekten çok daha ucuz.
- İstemcinin bağlanma amacı bilinmeden **her bağlantıda tam `Agent` kurmak**.
- `App`'in ~800 alanlı tanrı nesnesi ve 140 metotlu `TuiState` trait'i.
  jcode'un kendi analizi açık: önce **durum** parçalanmalı, trait değil —
  yalnızca trait'i bölmek tanrı nesnesini tanım gereği yerinde bırakır.

## Durum

### Kurulan (L0/L1)

| Crate | Ne | Test |
|---|---|---|
| `arterm-message-types` | Message, ContentBlock, StreamEvent, ToolDefinition | 5 |
| `arterm-tool-types` | ToolOutput, izin/kategori, ad çözümleme | 4 |
| `arterm-agent-runtime` | InterruptSignal, soft-interrupt kuyruğu | 6 |
| `arterm-tool-core` | Tool trait, ToolContext, şema enjeksiyonu | 5 |
| `arterm-provider-core` | Provider trait, hata sınıflandırma, retry | 15 |
| `arterm-providers` | SSE çözücü, OpenAI akış çevirici | 13 |

### Sıradaki fazlar

Kapsam ölçüsü: TS envanterinde "asgari kullanılabilir ajan" 25.118 satır
(9 alt sistem); güvenlik/denetlenebilirlik +5.490; ileri alt sistemler +15.462.

1. **Provider adaptörleri** — `openai_compat` ve `ollama`'yı `Provider`
   trait'ine taşı; anthropic ekle. Eski `ChatProvider` kalkar.
   jcode'un dört katmanlı bölünmesi alınır: `provider-core` (sözleşme) /
   `provider-<ad>` (saf tel tipleri, reqwest ve tokio **yok**) /
   `provider-<ad>-runtime` (HTTP, kimlik, retry) / kompozisyon. Bölünme
   estetik değil derleme argümanı: saf crate `is_oauth` gibi şeyleri
   **parametre olarak** alır, config okumaz — disiplin kopyalanmazsa crate
   sayısı artar, fayda gelmez.
2. **Tool katmanı** — `arterm-tools`'u `Tool` trait'ine taşı. Sandbox sınırı
   ve `arterm-command-risk` (hasar yarıçapı analizi) burada başlar.
3. **`arterm-app-core`** — ajan döngüsünü TUI'den çıkar. Tur döngüsü, tool
   yığın planlama (paralel/seri), compaction, soft interrupt.
4. **`arterm-session-types` + kalıcılık** — oturum diske, journal, resume.
5. **`arterm-protocol` + `arterm-server`** — daemon. Asgari küme 15 parça:
   soket yolu + flock, ölü-soket kanıtlama (tahmin değil dört adımlı kanıt),
   hazır-fd el sıkışma (`setsid`), istemci tarafı spawn kilidi, NDJSON
   istek/olay, iptal-kapsamlı görev havuzu, oturum tablosu, **ajan
   mutex'inin dışında tutulan sinyaller** (yoksa tool çalışırken iptal
   imkânsız — tool mutex'i tutuyor), tur-iptal kaydı, disconnect temizliği,
   boşta zaman aşımı, yeniden bağlanma. Reload/exec, debug soketi ve swarm
   RPC ertelenir.
6. **TUI'nin istemciye dönüşü** — protokol üzerinden konuşur.
7. **İleri alt sistemler** — verify gate, chronicle, hooks, telemetry,
   autonomy, swarm, memory.
