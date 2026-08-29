<?php
/**
 * Plugin Name: SalesPintar CAPI Bridge
 * Plugin URI: https://salespintar.com
 * Description: Integrasi Landing Page dengan SalesPintar untuk merekam Cookie Meta Ads (fbp/fbc) dari forms.id / form lokal.
 * Version: 1.0.0
 * Author: SalesPintar
 * Author URI: https://salespintar.com
 */

if (!defined('ABSPATH')) {
    exit;
}

// 1. Menu Admin
add_action('admin_menu', 'sp_capi_bridge_menu');
function sp_capi_bridge_menu() {
    add_options_page('SalesPintar CAPI Bridge', 'SalesPintar CAPI', 'manage_options', 'sp-capi-bridge', 'sp_capi_bridge_options_page');
}

// 2. Registrasi Setting
add_action('admin_init', 'sp_capi_bridge_settings');
function sp_capi_bridge_settings() {
    register_setting('sp_capi_bridge_group', 'sp_business_id');
    register_setting('sp_capi_bridge_group', 'sp_api_url');
}

// 3. Tampilan Halaman Setting
function sp_capi_bridge_options_page() {
    ?>
    <div class="wrap">
        <h2>Konfigurasi SalesPintar CAPI Bridge</h2>
        <form method="post" action="options.php">
            <?php settings_fields('sp_capi_bridge_group'); ?>
            <?php do_settings_sections('sp_capi_bridge_group'); ?>
            <table class="form-table">
                <tr valign="top">
                    <th scope="row">Business ID (SalesPintar)</th>
                    <td>
                        <input type="text" name="sp_business_id" value="<?php echo esc_attr(get_option('sp_business_id')); ?>" style="width: 350px;" />
                        <p class="description">Dapatkan UUID Business ID ini dari Dashboard SalesPintar Anda.</p>
                    </td>
                </tr>
                <tr valign="top">
                    <th scope="row">API Endpoint (URL SalesPintar)</th>
                    <td>
                        <input type="text" name="sp_api_url" value="<?php echo esc_attr(get_option('sp_api_url', 'https://api.salespintar.com/api/v1/meta-capi/attribution')); ?>" style="width: 350px;" />
                        <p class="description">Gunakan default, atau ganti jika Anda menggunakan custom domain API.</p>
                    </td>
                </tr>
            </table>
            <?php submit_button(); ?>
        </form>
    </div>
    <?php
}

// 4. Inject Script JS ke Frontend
add_action('wp_enqueue_scripts', 'sp_capi_bridge_enqueue_scripts');
function sp_capi_bridge_enqueue_scripts() {
    $business_id = get_option('sp_business_id');
    $api_url = get_option('sp_api_url', 'https://api.salespintar.com/api/v1/meta-capi/attribution');
    
    // Hanya inject jika business_id sudah diisi
    if (!empty($business_id)) {
        wp_enqueue_script('sp-capi-bridge-js', plugin_dir_url(__FILE__) . 'assets/salespintar-capi-v3.js', array(), time(), true);
        wp_localize_script('sp-capi-bridge-js', 'spCapiBridgeData', array(
            'businessId' => $business_id,
            'apiUrl'     => $api_url
        ));
    }
}
