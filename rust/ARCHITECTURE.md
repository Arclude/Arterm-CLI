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
| Ortam değişkeni temizliği | **yok** — `bash` ve hook'lar tüm ortamı miras alır | `scrubEnv`, ad tabanlı | TS |
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
