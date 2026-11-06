# The Last Vote Android

기존 `imnotahuman/mobile`의 WebView 래퍼를 재사용합니다.
접속 주소는 `https://thelastvote.ai-ve.uk`, 패키지는 `uk.aive.thelastvote`입니다.
앱 이름은 The Last Vote이고 versionCode 1, versionName 1.0.0입니다.
Android 8 이상과 인터넷 연결이 필요합니다. 아이콘은 `public/favicon.svg`의 경로를
Android vector drawable로 옮겼습니다.

`mobile/`에서 `./build_apk.sh`를 실행하면 서명을 검증한 `TheLastVote.apk`를 만듭니다.
툴체인은 `~/android-build/native/`의 JDK 17·SDK를 사용합니다.
서명 키는 `~/vault/thelastvote/signing/thelastvote-release.p12`, 비밀번호는 같은 폴더의
`release.password`입니다. 권한 600을 유지하고 업데이트에도 같은 키를 사용합니다.
키가 없으면 릴리스 빌드는 실패합니다.

Android 권한은 INTERNET과 ACCESS_NETWORK_STATE만 선언했습니다.
AndroidX가 추가하는 `uk.aive.thelastvote.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`은
앱 내부의 서명 보호 권한이며 사용자에게 요청하는 접근 권한이 아닙니다.
기기 자동 백업과 HTTP 접속을 금지하고 외부 링크는 외부 앱으로 엽니다.
