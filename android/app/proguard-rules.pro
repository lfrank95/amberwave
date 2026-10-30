# Die Brücke zur Oberfläche wird per Name aus JavaScript aufgerufen
-keepclassmembers class io.github.lfrank95.amberwave.Bruecke {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes JavascriptInterface
