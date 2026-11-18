<?php
// BENCHMARK: vulnerable - WordPress SQL injection
global $wpdb;

$rows = $wpdb->get_results('SELECT * FROM wp_orders WHERE status = ' . $_GET['status']);
