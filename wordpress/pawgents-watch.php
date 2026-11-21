<?php
/**
 * Plugin Name: Pawgents Watch (PROTOTYPE)
 * Description: Sends PHP fatal errors and browser JavaScript errors from this site to the Webpuppies Pawgents relay, which asks an agent to prepare a tested fix as a draft pull request. Throwaway prototype.
 * Version: 0.1.0
 *
 * Install: copy to wp-content/mu-plugins/pawgents-watch.php and add to wp-config.php:
 *   define( 'PAWGENTS_RELAY_URL', 'https://pawgents-relay.example.workers.dev' );
 *   define( 'PAWGENTS_SECRET', '...shared HMAC secret...' );
 *
 * Sends: error message, file, line, request path (no query string), WP/PHP versions, active plugins.
 * Never sends: cookies, POST bodies, query strings, user data, wp-config values.
 */

defined( 'ABSPATH' ) || exit;

if ( ! defined( 'PAWGENTS_RELAY_URL' ) || ! defined( 'PAWGENTS_SECRET' ) ) {
	return;
}

function pawgents_site() {
	return preg_replace( '/^www\./', '', wp_parse_url( home_url(), PHP_URL_HOST ) );
}

function pawgents_send( $path, array $payload ) {
	$body = wp_json_encode( $payload );
	wp_remote_post(
		PAWGENTS_RELAY_URL . $path,
		array(
			'timeout'  => 3,
			'blocking' => false, // Never slow the visitor's request down.
			'headers'  => array(
				'content-type'         => 'application/json',
				'x-pawgents-signature' => hash_hmac( 'sha256', $body, PAWGENTS_SECRET ),
			),
			'body'     => $body,
		)
	);
}

// PHP fatals. Runs alongside WordPress's own fatal error handler / recovery mode, not instead of it.
register_shutdown_function(
	function () {
		$e = error_get_last();
		if ( ! $e || ! in_array( $e['type'], array( E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR, E_RECOVERABLE_ERROR ), true ) ) {
			return;
		}
		// Local rate limit: one report per fingerprint per hour, so a crash loop is one message, not thousands.
		$key = 'pawgents_' . md5( $e['message'] . $e['file'] . $e['line'] );
		if ( get_transient( $key ) ) {
			return;
		}
		set_transient( $key, 1, HOUR_IN_SECONDS );

		$path = isset( $_SERVER['REQUEST_URI'] ) ? strtok( wp_unslash( $_SERVER['REQUEST_URI'] ), '?' ) : '';
		pawgents_send(
			'/wp',
			array(
				'site'    => pawgents_site(),
				'message' => $e['message'],
				'file'    => str_replace( ABSPATH, '', $e['file'] ),
				'line'    => $e['line'],
				'url'     => home_url( $path ),
				'wp'      => get_bloginfo( 'version' ),
				'php'     => PHP_VERSION,
				'plugins' => array_values( (array) get_option( 'active_plugins', array() ) ),
			)
		);
	}
);

// Browser errors: a tiny beacon, at most 3 reports per page view, posted straight to the relay.
add_action(
	'wp_head',
	function () {
		$relay = esc_url( PAWGENTS_RELAY_URL . '/js' );
		$site  = esc_js( pawgents_site() );
		echo "<script>(function(){var n=0;function s(m,st){if(n++>2)return;try{navigator.sendBeacon('{$relay}',JSON.stringify({site:'{$site}',message:String(m).slice(0,500),stack:String(st||'').slice(0,2000),url:location.origin+location.pathname,ua:navigator.userAgent}))}catch(e){}}addEventListener('error',function(e){s(e.message,e.error&&e.error.stack)});addEventListener('unhandledrejection',function(e){var r=e.reason||{};s(r.message||r,r.stack)})})();</script>\n";
	},
	1
);
