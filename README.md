# Meet Canlı Çeviri

Google Meet için Chrome uzantısı:

- **Karşı taraf** (Türkçe, İspanyolca, Fransızca, Almanca, İtalyanca, Rusça, Portekizce) konuşurken ekranda **canlı İngilizce altyazı** görürsünüz.
- **Siz İngilizce konuştuğunuzda**, sözleriniz karşı tarafın dilinde **seslendirilip** Meet'e mikrofonunuzmuş gibi gönderilir.

Kullanılan servisler: konuşma tanıma için ElevenLabs Scribe v3 Live, çeviri için Anthropic Claude (varsayılan Haiku 5.5, düşünme kapalı), seslendirme için ElevenLabs v4 Turbo.

## Kurulum

1. `.env` dosyasını açın ve iki anahtarı yazın:
   ```
   ELEVENLABS_API_KEY=...
   ANTHROPIC_API_KEY=...
   ```
   Diğer ayarlar isteğe bağlıdır; açıklamalar `.env.example` içinde.
2. Proje klasöründe derleyin:
   ```
   npm install
   npm run build
   ```
3. Chrome'da `chrome://extensions` adresini açın, **Geliştirici modu**nu açın, **Paketlenmemiş öğe yükle** ile `dist` klasörünü seçin.
4. Eklentinin **Ayarlar** sayfasında **Bağlantıyı test et** düğmesine basın. Anahtarları, modeli, sesi ve gecikmeyi kontrol eder.

`.env` değiştirdiğinizde `npm run build` çalıştırıp `chrome://extensions` sayfasında eklentiyi yenileyin (↻). Ayarlar sayfasında girilen değerler `.env`'deki değerlerin önüne geçer.

> `.env` ve `dist/` anahtarlarınızı içerir: paylaşmayın, bir yere yüklemeyin.

## Kullanım

1. Eklentiyi yükledikten **sonra** Meet sekmesini açın (açıksa yenileyin) ve toplantıya katılın.
2. Eklenti simgesine tıklayın, karşı tarafın dilini seçin ve **Çeviriyi başlat**'a basın.
3. Ekranın altındaki panel altyazıları, gecikmeyi ve durumu gösterir. Paneli tutamacından sürükleyebilirsiniz; **Metin** düğmesi tüm konuşma dökümünü gösterir, kopyalar veya indirir.
4. Görüşme sırasında popup'tan başka bir dil seçerseniz çeviri o dile geçer.

İpuçları:
- **Kulaklık kullanın.** Hoparlörden gelen ses mikrofona karışırsa yankı oluşabilir.
- Kendi sesinizle konuşmak için ElevenLabs'te bir ses klonu oluşturun ve kimliğini `VOICE_ID` (veya Ayarlar) alanına yazın.
- Kişi, şirket ve ürün adlarını `GLOSSARY` / **Özel isimler ve terimler** alanına ekleyin. Hem tanıma hem çeviri doğruluğu artar.

## Gecikme ve kalite

- Karşı taraf konuşurken altyazı **anlık taslak** olarak gelir. Cümle bitince kesin çeviri yazılır.
- Siz konuşurken cümle bitmeden çeviri başlar (spekülatif çeviri). Çeviri cümle cümle akarak seslendirmeye gider.
- Oturum başında bağlantılar ısıtılır; ilk cümle de diğerleri kadar hızlı çevrilir.

Gerçek API'lerle ölçülen çeviri hızı (13 Kasım 2026, ilk kelime / tam çeviri):

| Model | Süre | Not |
|---|---|---|
| **Haiku 5.5** (varsayılan) | 0,6 / 0,9 sn | En hızlı ve en ucuz; günlük ve iş konuşmasında doğru |
| Opus 5.5 + hızlı mod | 0,7 / 0,8 sn | En nüanslı çeviri; Claude ücreti Haiku'nun onlarca katı |
| Sonnet 5.5 | 1,8 / 2,3 sn | |
| Opus 5.5 (normal) | 1,9 / 2,5 sn | |

## Sorun giderme

| Belirti | Çözüm |
|---|---|
| "Meet sekmesine ulaşılamadı" | Eklentiyi yükledikten/güncelledikten sonra Meet sekmesini yenileyin. |
| Panelde "Meet sayfasında herhangi bir yere tıklayın" | Tarayıcı sesi başlatmak için bir tıklama bekliyor; sayfada bir yere tıklayın. |
| İngilizce altyazı gelmiyor | Paneldeki **Tanı** düğmesine basın: "Gelen ses" seviyesi hareket etmiyorsa ses alınamıyor demektir. **Tanı raporunu kopyala** ile raporu geliştiriciye iletin. |
| Toplantı sesi yanlış hoparlörden geliyor | Varsayılan "Sekme sesi" modunda ses Windows'un varsayılan çıkışından gelir: kulaklığınızı Windows'ta varsayılan yapın. |
| Karşı taraf sizi duymuyor | Meet'te mikrofonunuzun açık olduğundan emin olun. Ayarlar → Bağlantıyı test et. |
| Çeviri gecikiyor | Ayarlar'da gecikmeyi gösterin; modeli Sonnet/Haiku, sesi Flash v2.5 yapın. |

## Geliştirme

- `npm run build`: `dist/` klasörünü üretir (`.env` → `dist/env.json`).
- `npm test`: tüm birim testlerini çalıştırır.
- Mimari: `src/inject.js` sayfa içinde sanal mikrofon ve uzak ses yakalama yapar. `src/content.js` köprü ve altyazı panelidir. `src/background.js` oturumu yönetir. `src/offscreen.js` ve `src/engine/*` STT, çeviri ve TTS motorudur. Ayrıntılar `CONTRACT.md` içinde.
