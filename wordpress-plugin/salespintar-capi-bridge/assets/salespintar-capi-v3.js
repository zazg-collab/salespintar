(function() {
    console.log("SalesPintar CAPI Bridge: Initialized.");
    
    if (typeof spCapiBridgeData === 'undefined' || !spCapiBridgeData.businessId) {
        console.warn("SalesPintar CAPI Bridge: Konfigurasi Business ID kosong, pengiriman event dihentikan.");
        return;
    }

    const businessId = spCapiBridgeData.businessId;
    const apiUrl = spCapiBridgeData.apiUrl;

    function getCookie(name) {
        const value = `; ${document.cookie}`;
        const parts = value.split(`; ${name}=`);
        if (parts.length === 2) return parts.pop().split(';').shift();
        return null;
    }

    function getUrlParameter(name) {
        name = name.replace(/[\[]/, '\\[').replace(/[\]]/, '\\]');
        var regex = new RegExp('[\\?&]' + name + '=([^&#]*)');
        var results = regex.exec(location.search);
        return results === null ? '' : decodeURIComponent(results[1].replace(/\+/g, ' '));
    }

    function getMetaCookies() {
        let fbp = getCookie('_fbp');
        let fbc = getCookie('_fbc');

        if (!fbc) {
            const fbclid = getUrlParameter('fbclid');
            if (fbclid) {
                fbc = `fb.1.${Date.now()}.${fbclid}`;
            }
        }
        return { fbp, fbc };
    }

    function findInputInShadowDOM(rootNode, selectors) {
        let input = rootNode.querySelector(selectors);
        if (input) return input;

        const allNodes = rootNode.querySelectorAll('*');
        for (let i = 0; i < allNodes.length; i++) {
            if (allNodes[i].shadowRoot) {
                input = allNodes[i].shadowRoot.querySelector(selectors);
                if (input) return input;
                input = findInputInShadowDOM(allNodes[i].shadowRoot, selectors);
                if (input) return input;
            }
        }
        return null;
    }

    function sendAttribution(phoneInput, nameInput) {
        const waNumber = phoneInput ? phoneInput.value : '';
        if (!waNumber || waNumber.length < 9) {
            console.log("SalesPintar CAPI Bridge: Nomor WA tidak valid atau kosong:", waNumber);
            return;
        }

        const name = nameInput ? nameInput.value : '';
        const { fbp, fbc } = getMetaCookies();
        const productName = document.title;

        const payload = {
            businessId: businessId,
            waNumber: waNumber,
            name: name,
            fbp: fbp,
            fbc: fbc,
            userAgent: navigator.userAgent,
            landingUrl: window.location.href,
            productName: productName
        };
        
        console.log("SalesPintar CAPI Bridge: Mengirim Data Atribusi:", payload, "ke URL:", apiUrl);

        const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
        
        if (navigator.sendBeacon) {
            let success = navigator.sendBeacon(apiUrl, blob);
            console.log("SalesPintar CAPI Bridge: sendBeacon result:", success);
        } else {
            fetch(apiUrl, {
                method: 'POST',
                body: JSON.stringify(payload),
                headers: { 'Content-Type': 'application/json' },
                keepalive: true
            }).then(r => console.log("SalesPintar CAPI Bridge: fetch status", r.status))
              .catch(e => console.error("SalesPintar CAPI Bridge: fetch error", e));
        }
    }

    document.addEventListener('click', function(e) {
        // Pakai composedPath untuk mendeteksi klik tembus ke dalam Shadow DOM forms.id
        let path = e.composedPath ? e.composedPath() : [e.target];
        let isSubmitButton = false;
        let isInsideFormOrWidget = false;

        for (let i = 0; i < path.length; i++) {
            let el = path[i];
            if (!el || !el.tagName) continue;

            let tag = el.tagName.toLowerCase();
            if (tag === 'form' || tag.includes('mengantar-form-widget')) {
                isInsideFormOrWidget = true;
            }

            if (tag === 'button' || (tag === 'input' && (el.type === 'submit' || el.type === 'button'))) {
                isSubmitButton = true;
            }
        }

        // HANYA lanjut jika yang diklik adalah TOMBOL di dalam FORM/WIDGET
        if (!isSubmitButton || !isInsideFormOrWidget) return;

        console.log("SalesPintar CAPI Bridge: Klik tombol form terdeteksi.");

        const phoneInput = findInputInShadowDOM(document.body, 'input[type="tel"], input[name*="phone"], input[name*="wa"], input[placeholder*="WA"], input[placeholder*="WhatsApp"], input[placeholder*="wa"]');
        const nameInput = findInputInShadowDOM(document.body, 'input[type="text"][name*="name"], input[placeholder*="Nama"], input[placeholder*="nama"]');
        
        if (phoneInput && phoneInput.value) {
            sendAttribution(phoneInput, nameInput);
        } else {
            console.log("SalesPintar CAPI Bridge: Input nomor HP tidak ditemukan atau kosong.");
        }
    }, true);
})();
