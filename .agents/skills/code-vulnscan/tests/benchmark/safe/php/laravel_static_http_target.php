<?php
// BENCHMARK: safe - fixed service URL
use Illuminate\Support\Facades\Http;

$response = Http::get(config('services.catalog.url'));
