<?php
// BENCHMARK: vulnerable - Laravel SSRF
use Illuminate\Support\Facades\Http;

return Http::get(request('url'));
