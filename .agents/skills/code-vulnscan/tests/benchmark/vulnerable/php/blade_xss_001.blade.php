{{-- BENCHMARK: vulnerable - Blade raw output XSS --}}
<div>{!! request('bio') !!}</div>
