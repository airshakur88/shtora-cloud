<?php
// BENCHMARK: vulnerable - PHP object injection

$preferences = unserialize($_COOKIE['preferences']);
