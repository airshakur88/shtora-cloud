<?php
// BENCHMARK: safe - WordPress placeholder query
global $wpdb;

$rows = $wpdb->get_results($wpdb->prepare(
    'SELECT * FROM wp_orders WHERE status = %s',
    $_GET['status']
));
